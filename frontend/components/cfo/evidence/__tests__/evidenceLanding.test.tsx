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
// does not have (bs / cf / pnl / p_and_l / statements); an item whose
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
import { formatAmountFrom } from "@/lib/money";

vi.mock("@/stores/currency", async (orig) => {
  const { formatAmountFrom: f } = await import("@/lib/money");
  return {
    ...(await orig<typeof import("@/stores/currency")>()),
    useAmountFormatter: () => (v: number | null | undefined, opts: Record<string, unknown> = {}) =>
      f(v, "RON", "RON", { RON: 1, EUR: 5, USD: 4.6 } as never, opts),
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
import type { SectorBenchmarkDoc } from "@/lib/sectorBenchmark";
import type { AttentionDoc } from "@/lib/attention";
import type { PeriodLineItem } from "@/lib/activePeriod";
import {
  accountView,
  nowItemView,
  ratioView,
  statementView,
  type ViewContext,
} from "@/components/instrument/shell/cmdbar/cmdbarViews";
import { ANSWERS } from "@/components/instrument/shell/cmdbar/cmdbarIndex";
import { servedEbitda, servedLine, servedNetResult, ratioTableRows } from "@/components/instrument/shell/cmdbar/cmdbarSources";
import strings from "@/components/cfo/evidence/evidenceStrings.json";

const REPO = resolve(__dirname, "../../../../..");
const read = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf-8"));

const SCANDIA = read("e2e/fixtures/workspace_v2/scandia_fy2025.json").period;
const AGRAS = read("e2e/fixtures/workspace_v2/agras_fy2025.json").period;
const PAIR = read("frontend/lib/__tests__/fixtures/comparatives/pair_served.json");
const SECTOR_PAIR = read("frontend/lib/__tests__/fixtures/sectorBenchmark/served_pair.json").with_prior;

const RATES = { RON: 1, EUR: 5, USD: 4.6 };
const full = (v: number) => formatAmountFrom(v, "RON", "RON", RATES as never, {});

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
    printer: { lang: "en", money: (v: number) => formatAmountFrom(v, "RON", "RON", RATES as never, { compact: true }) },
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

// ════════════════════════════════════════════════════════════════════════

describe("cmdbar-evidence — every 'Ce contează acum' item lands on its evidence", () => {
  for (const w of WORLDS) {
    it(`${w.name}: each served item opens a rendered, highlighted target that IS the item`, async () => {
      const ctx = ctxOf(w);
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
        cleanup();
      }
    });
  }

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
    expect(d.querySelector('[data-testid="evidence-absent"]')?.textContent).toContain(offByOne);
    expect(d.querySelectorAll('[data-testid="evidence-leaf"]').length).toBe(0);
    expect(d.textContent).not.toMatch(/(^|\s)0([.,]00)?(\s|$)/);
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
