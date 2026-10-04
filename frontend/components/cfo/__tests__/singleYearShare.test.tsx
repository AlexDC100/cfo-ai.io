// "% DIN VENITURI" WORKS FOR ONE YEAR — AND THE COMPARISON SAYS WHAT IT IS.
//
// OWNER RULING (2026-10-04): "'% din venituri' must work for a single year
// without a comparison. Engine change, with a gate."
//
// INCIDENT. The statement tabs' share column ("% of revenue" on the P&L, "%
// of total assets" on the balance sheet) was painted from the engine's
// two-period comparatives document — so a company with one year on file, or
// its earliest year on screen, could not see what share of turnover each
// line is; the morning's hotfix switched the box off with the other three.
// And the balance-sheet share was never an engine figure at all: the tab
// divided each row by total assets in the browser.
//
// LAW.
//  S4  The share column is not a comparison column. With NO document on
//      screen — no prior resolves, the reader chose "No comparison", the
//      company has one period, the request was refused or failed — the P&L
//      and the balance sheet offer the share box, ENABLED, and paint ONE
//      extra column from the period's own served block
//      (`statements.common_size`): every printed string is the served
//      fraction through `formatShare`, in the reader's language. The other
//      three boxes stay off. A row carries the share only if the amount it
//      shows IS the block's, to the cent. A line with no share says why and
//      never prints 0 %. A payload without the block switches the box off
//      with a reason and computes nothing. The reader's stored columns are
//      read, never written, by any state. With a document on screen the
//      columns are the document's, and its share IS the block's (one figure
//      per page) — on the balance sheet too, where nothing is divided now.
//  S5  A comparison period that closes LATER reads backwards: one sentence
//      says so, no line is listed as improved / deteriorated, and the bridge
//      names each period by its own month — never "prior" for a later one.
//  S6  A refused or failed request is said ONCE under the tab bar on every
//      tab that has the controls; "try again" asks once more (no loop); the
//      comparison boxes are off with the reason meanwhile.
//  S7  "No prior" is said one way: the Ratios tab at most once, the
//      cash-flow card in the informal register, its action naming the month.
//
// Fails on: the share box off, or no column, with a served block and no
// document (the ruling); a share cell that is not `formatShare(served
// share)`; a share printed in the other language's number shape; a row
// built another way carrying the engine's share; 0 % (or any figure) on a
// refused / absent / no-base line; a crash or a computed share on a payload
// without the block; a state that writes the stored columns; the document's
// share differing from the block's for a key; a division, a multiplication
// or a rounding in a file on the share path; verdict lists under a later
// comparison period, or "prior" / "anterior" on its bridge; a refusal or a
// failure with no sentence on a tab, or said twice; an automatic retry; the
// Ratios tab repeating the sentence; a formal-register sentence.
//
// THE DASHBOARD PAGE ITSELF is the gate's SECOND FILE
// (`pages/cfo/__tests__/singleYearSharePage.test.tsx`): it mounts
// `FinancialStatements.tsx` with the network mocked and holds what a reader
// sees. Here the page's COMPOSITION is rendered — the controls, the two
// notes, each statement's provider and what the tab can paint are
// `lib/comparisonSurface.ts` and `components/cfo/ComparisonSurface.tsx`,
// which the page AND the `Dashboard` harness below both render (first review
// of 2026-10-04: five defects planted in the page's own inline composition
// left this gate green) — and what stays in the page, one call and three
// elements, is held to its exact text by the source laws at the foot of this
// file. Text laws read what they were told to read: the second review
// planted the same defects one wrapper element away and they stayed green,
// which is why the page is mounted now.
//
// What it cannot see: whether the ENGINE's shares are right (gate
// common-size-single holds the identity over the corpus; the fixtures here
// are its bytes); the balance sheet's Δ %, which is still the browser's
// classifier over the row's own two figures (the engine serves no percentage
// for a canonical row); the exported report / workbook / PDF's own share
// column and band lists, and the command bar (out of scope, S8). THE SOURCE
// LAWS' LIMIT: a share-path file holds no arithmetic, loads no module the
// law cannot read and imports no package but the four it imported before;
// a module it imports holds the arithmetic it held when it
// was trusted (pinned by text) and re-exports nothing unscanned — but what a
// TRUSTED module itself imports is not followed (a division two modules
// away, reached through a new function with no arithmetic of its own), and
// no law by value can see a division that reproduces the served fraction to
// the printed decimal.
// Plant log: docs/engine_book/gates.md, "single-year-share".
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, hydrate } from "@tanstack/react-query";
import ts from "typescript";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";
import { TestProviders, renderWithProviders } from "@/test/renderWithProviders";
import { foreignNumber } from "@/test/numberLanguage";

import pairJson from "@/lib/__tests__/fixtures/comparatives/pair_served.json";
import laterJson from "@/lib/__tests__/fixtures/comparatives/pair_prior_later.json";
import periodsJson from "@/lib/__tests__/fixtures/comparatives/period_common_size.json";
import constructedJson from "@/lib/__tests__/fixtures/oneEbitda/constructed_books.json";
import regimeJson from "@/lib/__tests__/fixtures/served_credit_regime.json";

// Whole statement tabs are rendered, several per test (five tabs × two
// languages): on a machine busy with other suites a law must not go red on
// the clock.
vi.setConfig({ testTimeout: 30_000 });

// ── A company: the committed pair's own two periods (the engine's ids) ──
const ORG = "0c0a0000-0000-4000-8000-00000000c0a1";
const P25 = "period-agras-fy2025";
const P24 = "period-carniprod-fy2024";

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "tok", user: { id: "u1" } } } }) },
    // The app's providers mirror a preference through an RPC; nothing here
    // reads the answer.
    rpc: async () => ({ data: null, error: null }),
  }),
  currentOrgId: async () => "0c0a0000-0000-4000-8000-00000000c0a1",
}));

const {
  COMPARATIVES_NO_PRIOR_NOTE_ID,
  COMPARATIVES_OUTCOME_NOTE_ID,
  COMPARATIVES_SHARE_NOTE_ID,
  ComparativesSummary,
  ComparisonOutcomeNote,
  PENDING_NOTE_DELAY_MS,
  RatioCompareCtx,
} = await import("@/components/cfo/ComparativesPanel");
// THE PAGE'S OWN COMPOSITION — the three components and the one function
// the dashboard renders. Nothing below re-implements a condition of theirs.
const { ComparisonControlsBar, ComparisonNotes, StatementComparison } = await import(
  "@/components/cfo/ComparisonSurface"
);
const {
  COMPARISON_TABS,
  VERDICT_TABS,
  comparisonSurfaceOf,
  documentPredatesDirection,
  statementComparisonOf,
} = await import("@/lib/comparisonSurface");
const { comparisonNamesPeriod, resetPeriodAnswers } = await import("@/lib/periodReset");
const { periodQueryKey } = await import("@/lib/activePeriod");
const { PLStatementView } = await import("@/components/cfo/PLStatementView");
const { BSStatementView } = await import("@/components/cfo/BSStatementView");
const { CashFlowStatementView } = await import("@/components/cfo/CashFlowStatementView");
const { RatiosTabContent } = await import("@/components/cfo/ratios/RatiosTab");
const { BandMovementLists } = await import("@/components/cfo/ratios/BandMovementLists");
const { RatioComparisonTable } = await import("@/components/cfo/ratios/RatioComparisonTable");
const {
  comparativesQueryKey,
  comparisonChoiceOf,
  formatPts,
  formatShare,
  missingPreviousYearEnd,
  rowIsEngineFigure,
  useComparatives,
} = await import("@/lib/comparatives");
const { readCommonSize, shareForRow, shareOfferOf } = await import("@/lib/commonSize");
const {
  absentLineWordKey,
  columnBoxesOf,
  comparisonBackwardsOf,
  comparisonBlockOf,
  comparisonNoteOf,
  comparisonSaidByPage,
  priorIsEarlier,
} = await import("@/lib/comparisonState");
const { ratioSurfacesOf } = await import("@/lib/useRatioSurfaces");
const { buildRatioCompareView, printBandMovements, readRatioTable, servedCreditEnvelopes } = await import(
  "@/lib/ratioCompareView"
);
const { pickPLBuilder } = await import("@/lib/buildPlStatement");
const { buildBSStatement } = await import("@/lib/buildBsStatement");
const { buildCashFlowStatement } = await import("@/lib/buildCashFlowStatement");
const { altmanRatio, computeRatios } = await import("@/lib/financialReport");
const { buildBandMovements } = await import("@/lib/executiveSummary");
const { computeCreditScore } = await import("@/lib/financialValuation");
const { ComparativesViewProvider, useComparativesView, readComparativesView } = await import(
  "@/stores/comparativesView"
);
const { QUERY_SESSION_STARTED_AT, answeredBeforeThisSession, setupQueryPersistence } = await import(
  "@/lib/queryPersist"
);
const { queryClient: appQueryClient } = await import("@/lib/queryClient");

type ComparativesResponse = import("@/lib/comparatives").ComparativesResponse;
type ComparativesFetch = import("@/lib/comparatives").ComparativesFetch;
type Statements = import("@/lib/financialReport").Statements;
type CanonicalBs = import("@/lib/financialReport").CanonicalBs;
type ApiLineItem = import("@/lib/plStructure").ApiLineItem;
type ShareOffer = import("@/lib/commonSize").ShareOffer;

type Tab = "overview" | "pl" | "balance_sheet" | "cash_flow" | "ratios";
const TABS: readonly Tab[] = ["overview", "pl", "balance_sheet", "cash_flow", "ratios"];
type Lang = "en" | "ro";

interface ServedRow { key: string; statement: "PL" | "BS"; current: number | null; share: number | null; status: string }
interface Body {
  statements: Statements & {
    canonical_bs?: CanonicalBs;
    common_size?: { schema: string; rows: ServedRow[] };
    assembled_pl: Record<string, unknown>;
    assembled_bs?: Record<string, number>;
    incomeStatement: Record<string, number>;
    margin_meaning?: { status: string; margins: string[] };
  };
  assembled_metrics: Record<string, unknown>;
  metrics: { name: string; value: number | null }[];
  line_items?: ApiLineItem[];
}
interface Pair { current_body: Body; comparatives: ComparativesResponse }

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** Dec 2025 on screen, Dec 2024 as the prior — and the 2025 body. */
const forward = (): Pair => clone(pairJson) as unknown as Pair;
/** Dec 2024 on screen, Dec 2025 as the "prior" — and the 2024 body. */
const later = (): Pair => clone(laterJson) as unknown as Pair;
const body25 = (): Body => forward().current_body;
const body24 = (): Body => later().current_body;
/** A book whose EBITDA the engine refused (served bytes). */
const refusedBody = (): Body =>
  clone((constructedJson as unknown as Record<string, Body>).g6_uncleared);
/** A book whose equity the engine refuses as incomplete — short by the
 *  year's refused result — with the equity figure still in its field
 *  (served bytes). */
const refusedEquityBody = (): Body =>
  clone((constructedJson as unknown as Record<string, Body>).unanchored_unbalanced);
/** The corpus developer: turnover is 0.6 % of its activity, so the engine's
 *  margin rule refuses every margin over it (served bytes). */
const developerBody = (): Body => {
  const served = clone((regimeJson as unknown as Record<string, Body>).developer);
  return { ...served, assembled_metrics: {}, metrics: served.metrics ?? [] };
};

interface Row { id: string; start: string; end: string }
const Y25: Row = { id: P25, start: "2025-01-01", end: "2025-12-31" };
const Y24: Row = { id: P24, start: "2024-01-01", end: "2024-12-31" };
const TWO_YEARS = [Y25, Y24];
const companyOf = (rows: Row[]) => ({
  orgId: ORG,
  periods: rows.map((r) => ({
    period_id: r.id,
    period_label: r.end,
    period_start: r.start,
    period_end: r.end,
    documents: [{ id: `doc-${r.id}` }],
  })),
});

/** What the engine answers for a pair; undefined = not answered yet. */
type Answers = (cur: string, prior: string) => ComparativesFetch | undefined;
const SERVED: Answers = (cur, prior) =>
  cur === P25 && prior === P24
    ? { kind: "ok", data: forward().comparatives }
    : cur === P24 && prior === P25
      ? { kind: "ok", data: later().comparatives }
      : undefined;

let cellsChecked = 0;
let statesChecked = 0;
const retried = vi.fn();

/**
 * THE DASHBOARD'S COMPARISON, for one tab — RENDERED BY THE PAGE'S OWN CODE.
 * What is the harness's: where the inputs come from (the reader's stored
 * choice → the one rule for the prior → the fetch sorted once,
 * `ratioSurfacesOf`, over the engine's committed bytes instead of a live
 * query) and the statement views inside the providers. What is NOT the
 * harness's: every condition — which tabs carry the controls, when a note
 * shows, what share column a tab is handed. Those are `comparisonSurfaceOf`
 * and the three components of components/cfo/ComparisonSurface.tsx, exactly
 * as pages/cfo/FinancialStatements.tsx renders them.
 */
function Dashboard({
  tab,
  body,
  rows,
  currentId,
  answers = SERVED,
  company = "known",
}: {
  tab: Tab;
  body: Body;
  rows: Row[];
  currentId: string;
  answers?: Answers;
  /** "unknown": the company's period list has not arrived (still loading,
   *  failed, or the period's company is not the one open) — the page then
   *  knows the period on screen and nothing about the others. */
  company?: "known" | "unknown";
}) {
  const view = useComparativesView();
  const currentEnd = rows.find((r) => r.id === currentId)?.end ?? null;
  const choice = comparisonChoiceOf(
    { currentId, currentEnd, currentOrgId: ORG, activeOrgId: ORG, stored: view.view.priorPeriodId },
    company === "known" ? companyOf(rows) : null,
  );
  const statements = body.statements;
  const metricsByName: Record<string, number | null> = {};
  for (const m of body.metrics ?? []) metricsByName[m.name] = typeof m.value === "number" ? m.value : null;
  const surfaces = ratioSurfacesOf({
    assembledMetrics: body.assembled_metrics,
    statements,
    metricsByName,
    currentLabel: statements.periodLabel ?? "",
    periodId: currentId,
    priorId: choice.priorId,
    comparatives: { data: choice.priorId ? answers(currentId, choice.priorId) : undefined },
  });
  const doc = surfaces.cmpDoc;
  const surface = comparisonSurfaceOf({
    tab,
    statements,
    rendersCanonicalBs: !!statements.canonical_bs,
    periods: choice.periods,
    currentId,
    currentEnd,
    autoPick: choice.autoPick,
    priorId: choice.priorId,
    stored: view.view.priorPeriodId,
    columns: view.view.columns,
    doc,
    outcome: surfaces.comparison,
  });
  return (
    <>
      <ComparisonControlsBar surface={surface} />
      <ComparisonNotes surface={surface} uploadHref={`/workspace?period=${currentId}`} onRetry={retried} />
      {tab === "pl" && (
        <StatementComparison surface={surface} statement="pl">
          <PLStatementView
            hideGuide
            statement={pickPLBuilder(
              { lineItems: body.line_items ?? [], entity: "E", period: statements.periodLabel, currency: statements.currency },
              statements,
            )}
          />
        </StatementComparison>
      )}
      {tab === "balance_sheet" && (
        <StatementComparison surface={surface} statement="balance_sheet">
          <BSStatementView
            hideGuide
            periodId={currentId}
            statement={buildBSStatement({
              lineItems: body.line_items ?? [],
              entity: "E",
              asOf: statements.periodLabel ?? "",
              comparativeDate: doc ? doc.prior.label : "Opening",
              currency: statements.currency,
              // A period with no canonical object renders the legacy build.
              assembledBs: statements.assembled_bs,
              canonicalBs: statements.canonical_bs,
              priorCanonicalBs: doc?.prior_canonical_bs ?? null,
            })}
          />
        </StatementComparison>
      )}
      {doc && (tab === "pl" || tab === "balance_sheet") && (
        <ComparativesSummary doc={doc} statement={tab === "pl" ? "PL" : "BS"} currency={statements.currency} />
      )}
    </>
  );
}

const mount = (props: Parameters<typeof Dashboard>[0]) => (
  <ComparativesViewProvider orgId={ORG}>
    <Dashboard {...props} />
  </ComparativesViewProvider>
);

async function language(lang: Lang): Promise<void> {
  await act(async () => {
    await i18n.changeLanguage(lang);
  });
}

const storeView = (v: { priorPeriodId: string | null | "none"; columns?: Partial<Record<string, boolean>> }) =>
  window.localStorage.setItem(
    "cfo:comparatives-view:v2:" + ORG,
    JSON.stringify({
      priorPeriodId: v.priorPeriodId,
      columns: { prior: true, delta: true, deltaPct: true, share: true, ...(v.columns ?? {}) },
    }),
  );

// ── What is on screen ─────────────────────────────────────────────────
const controls = () => screen.queryByTestId("comparatives-controls");
const box = (k: string) => screen.queryByTestId(`comparatives-col-${k}`) as HTMLInputElement | null;
const boxKeys = () =>
  (screen.queryAllByTestId(/^comparatives-col-/) as HTMLInputElement[]).map((b) => b.dataset.testid!.slice(17));
const noPriorNotice = () => screen.queryByTestId("comparatives-no-prior");
const outcomeNote = () => screen.queryByTestId("comparatives-outcome");
const shareOnlyCells = () => [...document.querySelectorAll<HTMLElement>('[data-cmp="share-only"]')];
const cellOf = (key: string) =>
  document.querySelector<HTMLElement>(`[data-cmp="share-only"][data-cmp-key="${key}"]`);
const plHeader = () => screen.queryByTestId("cmp-col-header");
const bundleOf = (lang: Lang) => (lang === "en" ? en : ro) as unknown as Record<string, unknown>;
const text = (lang: Lang, key: string): string => {
  const v = key
    .split(".")
    .reduce<unknown>((n, p) => (n && typeof n === "object" ? (n as Record<string, unknown>)[p] : undefined), bundleOf(lang));
  if (typeof v !== "string") throw new Error(`${lang}.json has no string at ${key}`);
  return v;
};
const servedRows = (b: Body): Map<string, ServedRow> =>
  new Map((b.statements.common_size?.rows ?? []).map((r) => [r.key, r]));

/** No sentence on screen is an untranslated key. */
function noRawKeys(): void {
  const seen = document.body.cloneNode(true) as HTMLElement;
  for (const el of seen.querySelectorAll("script, style")) el.remove();
  expect(seen.textContent ?? "").not.toMatch(/statements\.cmp\.|\{\{|\}\}/);
}

/** A clean browser, in Pro mode: every statement row is on screen (Simple
 *  mode opens totals-first — it has a law of its own below). */
function resetStorage(mode: "pro" | "simple" = "pro"): void {
  window.localStorage.clear();
  window.localStorage.setItem("cfo-view-mode-v1", mode);
}

beforeEach(async () => {
  resetStorage();
  retried.mockClear();
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterAll(async () => {
  await i18n.changeLanguage("en");
  // eslint-disable-next-line no-console
  console.log(`GATE-WORK single-year-share cells=${cellsChecked} states=${statesChecked}`);
});

// ── The fixtures are the subject ──────────────────────────────────────

describe("the fixtures are the engine's bytes, and they carry the subject", () => {
  it("both period bodies carry statements.common_size (common_size/1) with P&L, registry and canonical rows", () => {
    for (const [name, b] of [["Dec 2025", body25()], ["Dec 2024", body24()]] as const) {
      const block = readCommonSize(b.statements);
      expect(block, `${name}: no share block — every law below is vacuous`).not.toBeNull();
      expect(block!.schema).toBe("common_size/1");
      const keys = [...block!.rows.keys()];
      expect(keys.filter((k) => k.startsWith("pl.")).length).toBeGreaterThanOrEqual(20);
      expect(keys.filter((k) => k.startsWith("bs.row.")).length).toBeGreaterThanOrEqual(40);
      expect(block!.rows.get("bs.total.assets")?.share).toBe(1);
      expect(block!.rows.get("pl.revenue")?.share).toBe(1);
      statesChecked += 1;
    }
  });

  it("the stand-alone fixture is the same block as the one on each period body", () => {
    const periods = (periodsJson as unknown as {
      periods: Record<string, { common_size: { rows: ServedRow[] } }>;
    }).periods;
    for (const [id, b] of [[P25, body25()], [P24, body24()]] as const) {
      expect(periods[id].common_size.rows, id).toEqual(b.statements.common_size!.rows);
      statesChecked += 1;
    }
  });

  it("the single period's share IS the comparison's: current_share on the 2025 screen, prior_share for 2024", () => {
    const doc = forward().comparatives;
    const cur = servedRows(body25());
    const pri = servedRows(body24());
    let both = 0;
    for (const r of doc.common_size) {
      if (cur.has(r.key)) {
        expect(cur.get(r.key)!.share, `${r.key}: block vs document, current`).toBe(r.current_share);
        both += 1;
      }
      if (pri.has(r.key)) {
        expect(pri.get(r.key)!.share, `${r.key}: block vs document, prior`).toBe(r.prior_share);
        both += 1;
      }
    }
    expect(both).toBeGreaterThanOrEqual(200);
    cellsChecked += both;
  });
});

// ── S4: the incident state ────────────────────────────────────────────

/** Hand-written, so the expectation is not the printer's own output. */
const BY_HAND: Record<"pl" | "balance_sheet", Record<string, Record<Lang, string>>> = {
  pl: {
    "pl.revenue": { en: "100.0%", ro: "100,0%" },
    "pl.cogs": { en: "60.8%", ro: "60,8%" },
    "pl.ebitda": { en: "5.0%", ro: "5,0%" },
  },
  balance_sheet: {
    "bs.total.assets": { en: "100.0%", ro: "100,0%" },
    "bs.row.cash_operating": { en: "2.3%", ro: "2,3%" },
    "bs.section.current_assets": { en: "24.7%", ro: "24,7%" },
  },
};
const SHARE_LABEL: Record<"pl" | "balance_sheet", Record<Lang, string>> = {
  pl: { en: "% of revenue", ro: "% din venituri" },
  balance_sheet: { en: "% of total assets", ro: "% din total active" },
};

/** Every share cell on screen is the served fraction through the one
 *  printer, in `lang`'s number shape. Returns how many printed a share. */
function everyShareCellIsServed(b: Body, lang: Lang): number {
  const served = servedRows(b);
  let printed = 0;
  for (const cell of shareOnlyCells()) {
    const key = cell.getAttribute("data-cmp-key");
    const status = cell.getAttribute("data-share-status");
    const shown = cell.textContent ?? "";
    if (status === "share") {
      const row = served.get(key!);
      expect(row, `${key}: a share on screen for a key the engine did not serve`).toBeDefined();
      expect(row!.status, key!).toBe("share");
      expect(shown, key!).toBe(formatShare(row!.share, lang));
      expect(foreignNumber(shown, lang), `${key}: "${shown}" is not a ${lang} number`).toBeNull();
      printed += 1;
    } else {
      // No share: a word or the gap glyph — never a figure, never 0 %.
      expect(shown, `${key ?? "unmapped"} (${status})`).not.toMatch(/\d/);
    }
    cellsChecked += 1;
  }
  return printed;
}

describe("S4 the incident state — the company's earliest year on screen, AUTO selected", () => {
  for (const lang of ["ro", "en"] as const) {
    for (const tab of ["pl", "balance_sheet"] as const) {
      it(`${lang} · ${tab}: the share box is on, the other three are off, and ONE column is printed from the served block`, async () => {
        const b = body24();
        renderWithProviders(mount({ tab, body: b, rows: TWO_YEARS, currentId: P24 }));
        await language(lang);

        expect(controls()!.getAttribute("data-comparison")).toBe("no-prior");
        const notice = noPriorNotice();
        expect(notice, "the comparison is on, compares nothing, and says nothing").not.toBeNull();
        expect(boxKeys()).toEqual(["prior", "delta", "deltaPct", "share"]);
        for (const k of ["prior", "delta", "deltaPct"]) {
          expect(box(k)!.disabled, `${k} is enabled with nothing compared`).toBe(true);
          expect(box(k)!.checked, `${k} is ticked with no such column on screen`).toBe(false);
          expect(box(k)!.getAttribute("aria-describedby")).toBe(COMPARATIVES_NO_PRIOR_NOTE_ID);
          expect(box(k)!.closest("label")!.getAttribute("title")).toBe(text(lang, "statements.cmp.columnsDisabled"));
        }
        // THE RULING: the share box is the reader's own, with no comparison.
        expect(box("share")!.disabled, "the share box is off with a served block").toBe(false);
        expect(box("share")!.checked).toBe(true);
        expect(box("share")!.getAttribute("aria-describedby")).toBeNull();
        expect(box("share")!.closest("label")!.getAttribute("title")).toBeNull();
        expect(box("share")!.closest("label")!.textContent).toBe(SHARE_LABEL[tab][lang]);
        // The group is not "all off", and carries no reason of its own.
        const group = screen.getByTestId("comparatives-columns");
        expect(group.getAttribute("data-disabled")).toBe("false");
        expect(group.getAttribute("title")).toBeNull();

        // ONE extra column — the share — and no comparison cell.
        const statement = screen.getByTestId(tab === "pl" ? "pl-statement" : "bs-statement");
        expect(statement.getAttribute("data-share-only")).toBe("true");
        expect(statement.getAttribute("data-comparative")).toBeNull();
        expect(document.querySelectorAll(".cmp-cell--prior").length).toBe(0);
        if (tab === "pl") {
          const header = [...plHeader()!.children].map((c) => c.textContent);
          expect(header).toEqual(["", b.statements.periodLabel, SHARE_LABEL.pl[lang]]);
        } else {
          expect(screen.getByTestId("bs-share-header").textContent).toBe(SHARE_LABEL.balance_sheet[lang]);
          expect(statement.querySelectorAll(".bs-col-header .cmp-cells > span").length).toBe(1);
        }

        const printed = everyShareCellIsServed(b, lang);
        expect(printed, "no share printed").toBeGreaterThanOrEqual(tab === "pl" ? 14 : 40);
        for (const [key, words] of Object.entries(BY_HAND[tab])) {
          expect(cellOf(key)?.textContent, key).toBe(words[lang]);
        }
        noRawKeys();
        statesChecked += 1;
      });
    }
  }

  it("every canonical balance-sheet row, subtotal and total on screen prints its served share", () => {
    const b = body24();
    renderWithProviders(mount({ tab: "balance_sheet", body: b, rows: TWO_YEARS, currentId: P24 }));
    const served = servedRows(b);
    const cbs = b.statements.canonical_bs!;
    const onScreen = new Set(shareOnlyCells().map((c) => c.getAttribute("data-cmp-key")));
    let rows = 0;
    for (const r of cbs.rows) {
      const key = `bs.row.${r.id}`;
      expect(onScreen.has(key), `${key} has no share cell`).toBe(true);
      expect(cellOf(key)!.textContent).toBe(formatShare(served.get(key)!.share, "en"));
      rows += 1;
    }
    expect(rows).toBeGreaterThanOrEqual(40);
    for (const key of ["bs.total.assets", "bs.total.equity_plus_liabilities"]) {
      expect(cellOf(key)?.textContent, key).toBe("100.0%");
    }
    expect([...onScreen].filter((k) => k?.startsWith("bs.section.")).length).toBeGreaterThanOrEqual(5);
    // …and the served fraction is the figure the tab used to divide itself
    // (the row's own amount over total assets): nothing changed on screen.
    const total = served.get("bs.total.assets")!.current!;
    for (const r of cbs.rows) {
      const share = served.get(`bs.row.${r.id}`)!.share!;
      expect(Math.abs(share - r.amount / Math.abs(total)), r.id).toBeLessThan(5e-7);
    }
    cellsChecked += rows;
  });

  it("unticking the share box removes the column; ticking it brings it back — and only `share` is written", () => {
    storeView({ priorPeriodId: null, columns: { deltaPct: false } });
    renderWithProviders(mount({ tab: "pl", body: body24(), rows: TWO_YEARS, currentId: P24 }));
    expect(shareOnlyCells().length).toBeGreaterThan(0);

    fireEvent.click(box("share")!);
    expect(readComparativesView(ORG).columns).toEqual({ prior: true, delta: true, deltaPct: false, share: false });
    expect(box("share")!.checked).toBe(false);
    expect(shareOnlyCells()).toEqual([]);
    expect(plHeader()).toBeNull();
    expect(screen.getByTestId("pl-statement").getAttribute("data-share-only")).toBeNull();

    fireEvent.click(box("share")!);
    expect(readComparativesView(ORG).columns).toEqual({ prior: true, delta: true, deltaPct: false, share: true });
    expect(shareOnlyCells().length).toBeGreaterThan(0);
    statesChecked += 2;
  });

  it("Simple mode (totals first) carries the column too: every headline row prints its served share", () => {
    for (const tab of ["pl", "balance_sheet"] as const) {
      resetStorage("simple");
      const b = body24();
      const r = renderWithProviders(mount({ tab, body: b, rows: TWO_YEARS, currentId: P24 }));
      expect(everyShareCellIsServed(b, "en"), tab).toBeGreaterThanOrEqual(tab === "pl" ? 7 : 6);
      for (const key of tab === "pl" ? ["pl.revenue", "pl.ebitda", "pl.net_income"] : ["bs.total.assets", "bs.section.current_assets"]) {
        expect(cellOf(key), `${tab} ${key}`).not.toBeNull();
      }
      r.unmount();
      statesChecked += 1;
    }
  });

  it("a tab with no share column of its own (cash flow, ratios): all four boxes are off, as before", () => {
    for (const tab of ["cash_flow", "ratios"] as const) {
      const r = renderWithProviders(mount({ tab, body: body24(), rows: TWO_YEARS, currentId: P24 }));
      expect(boxKeys()).toEqual(["prior", "delta", "deltaPct", "share"]);
      for (const k of boxKeys()) expect(box(k)!.disabled && !box(k)!.checked, `${tab} ${k}`).toBe(true);
      const group = screen.getByTestId("comparatives-columns");
      expect(group.getAttribute("data-disabled")).toBe("true");
      expect(group.getAttribute("title")).toBe(text("en", "statements.cmp.columnsDisabled"));
      r.unmount();
      statesChecked += 1;
    }
  });
});

// ── S4: the row guard ─────────────────────────────────────────────────

describe("S4 the row guard — a row built another way carries no engine share", () => {
  it("P&L: a cost-of-sales row showing another amount is blank, with the reason; its neighbours keep theirs", async () => {
    const b = body24();
    // The row's own figure moves; the engine's block does not.
    b.statements.incomeStatement.costOfGoodsSold += 1000;
    for (const k of ["cogs", "cost_of_goods_sold"]) {
      if (typeof b.statements.assembled_pl[k] === "number") (b.statements.assembled_pl[k] as number) += 1000;
    }
    renderWithProviders(mount({ tab: "pl", body: b, rows: TWO_YEARS, currentId: P24 }));
    await language("ro");
    const cogs = cellOf("pl.cogs")!;
    expect(cogs.getAttribute("data-share-status")).toBe("definition-differs");
    expect(cogs.textContent).toBe("—");
    expect(cogs.querySelector(".cmp-cell")!.getAttribute("title")).toBe(text("ro", "statements.cmp.share.definitionDiffers"));
    expect(cellOf("pl.revenue")!.textContent).toBe("100,0%");
    statesChecked += 1;
  });

  it("balance sheet: a row whose amount is not the block's is blank; the rule is the comparison's own guard", () => {
    const b = body24();
    const row = b.statements.canonical_bs!.rows.find((r) => r.id === "cash_operating")!;
    row.amount += 1;
    renderWithProviders(mount({ tab: "balance_sheet", body: b, rows: TWO_YEARS, currentId: P24 }));
    const cell = cellOf("bs.row.cash_operating")!;
    expect(cell.getAttribute("data-share-status")).toBe("definition-differs");
    expect(cell.textContent).toBe("—");
    // One guard, both documents: half a cent, and absent is not a number.
    expect(rowIsEngineFigure(100, 100.004)).toBe(true);
    expect(rowIsEngineFigure(100, 100.006)).toBe(false);
    expect(rowIsEngineFigure(-100, 100)).toBe(true);
    expect(rowIsEngineFigure(0, null)).toBe(true);
    expect(rowIsEngineFigure(5, null)).toBe(false);
    expect(rowIsEngineFigure(null, 5)).toBe(true);
    const block = readCommonSize(body24().statements);
    expect(shareForRow(block, "ebitda", body24().statements.assembled_pl.ebitda as number).kind).toBe("share");
    expect(shareForRow(block, "ebitda", 1).kind).toBe("definition_differs");
    expect(shareForRow(block, "aRowNoEngineLineIs", 1).kind).toBe("unmapped");
    expect(shareForRow(null, "ebitda", 1).kind).toBe("unmapped");
    statesChecked += 9;
  });
});

// ── S3 / S4: a line with no share says why ────────────────────────────

describe("S4 a line with no share says why — never 0 %", () => {
  for (const lang of ["ro", "en"] as const) {
    it(`${lang}: a book whose EBITDA the engine refused prints the word, with the reason, on every refused line`, async () => {
      const b = refusedBody();
      const refused = (b.statements.common_size!.rows).filter((r) => r.status === "refused").map((r) => r.key);
      expect(refused).toContain("pl.ebitda");
      renderWithProviders(mount({ tab: "pl", body: b, rows: [Y25], currentId: P25 }));
      await language(lang);
      const cell = cellOf("pl.ebitda")!;
      expect(cell.getAttribute("data-share-status")).toBe("refused");
      expect(cell.textContent).toBe(text(lang, "statements.cmp.refused"));
      expect(cell.querySelector(".cmp-cell")!.getAttribute("title")).toBe(text(lang, "statements.cmp.share.refused"));
      let seen = 0;
      for (const c of shareOnlyCells()) {
        if (c.getAttribute("data-share-status") !== "refused") continue;
        expect(refused).toContain(c.getAttribute("data-cmp-key"));
        expect(c.textContent).not.toMatch(/\d/);
        seen += 1;
      }
      expect(seen).toBeGreaterThanOrEqual(2);
      // The lines the engine did serve still print.
      expect(cellOf("pl.revenue")!.textContent).toBe(lang === "ro" ? "100,0%" : "100.0%");
      everyShareCellIsServed(b, lang);
      noRawKeys();
      statesChecked += 1;
    });
  }

  for (const lang of ["ro", "en"] as const) {
    it(`${lang}: an equity the engine refuses as incomplete prints the word on the subtotal and the grand total — never the equity ratio`, async () => {
      // Served bytes (the review's witness): total equity is still IN its
      // field (200,000.00) with the completeness refusal beside it. Until
      // 2026-10-04 the block served it at 47.6 % of total assets — the
      // equity ratio the same body's ratio table refuses.
      const b = refusedEquityBody();
      const st = b.statements as unknown as { assembled_bs: { total_equity: number; total_equity_refusal?: { code: string } } };
      expect(st.assembled_bs.total_equity).toBe(200000);
      expect(st.assembled_bs.total_equity_refusal?.code).toBe("account_121_anchor_absent");
      renderWithProviders(mount({ tab: "balance_sheet", body: b, rows: [Y25], currentId: P25 }));
      await language(lang);
      for (const key of ["bs.section.equity", "bs.total.equity_plus_liabilities"]) {
        const cell = cellOf(key);
        expect(cell, `${key}: no share cell`).not.toBeNull();
        expect(cell!.getAttribute("data-share-status"), key).toBe("refused");
        expect(cell!.textContent, key).toBe(text(lang, "statements.cmp.refused"));
        expect(cell!.textContent, key).not.toMatch(/\d/);
      }
      // What the book posted stands: the equity ROWS and total assets.
      expect(cellOf("bs.row.share_capital")!.textContent).toBe(lang === "ro" ? "23,8%" : "23.8%");
      expect(cellOf("bs.total.assets")!.textContent).toBe(lang === "ro" ? "100,0%" : "100.0%");
      expect(document.body.textContent, "the refused equity ratio is on screen").not.toMatch(/47[.,]6\s*%/);
      everyShareCellIsServed(b, lang);
      statesChecked += 1;
    });

    it(`${lang}: a refused net result says "refused" on the P&L — not a gap that reads "not reported"`, async () => {
      const b = refusedEquityBody();
      renderWithProviders(mount({ tab: "pl", body: b, rows: [Y25], currentId: P25 }));
      await language(lang);
      const served = servedRows(b);
      expect(served.get("pl.net_income")!.status).toBe("refused");
      const cell = cellOf("pl.net_income");
      if (cell) {
        expect(cell.getAttribute("data-share-status")).toBe("refused");
        expect(cell.textContent).toBe(text(lang, "statements.cmp.refused"));
      }
      // …and no row on screen prints a share for it under any key.
      for (const c of shareOnlyCells()) {
        if (c.getAttribute("data-share-status") === "share") {
          expect(served.get(c.getAttribute("data-cmp-key")!)!.status).toBe("share");
        }
      }
      everyShareCellIsServed(b, lang);
      statesChecked += 1;
    });

    it(`${lang}: a margin the engine's rule refuses is not printed as a share — the developer's result lines say "not meaningful"`, async () => {
      // Served bytes: the corpus developer (turnover 0.6 % of its activity).
      // The ratio table refuses its margins; until 2026-10-04 the share
      // column printed them all the same (EBITDA "339.3%", net "-493.7%").
      const b = developerBody();
      expect(b.statements.margin_meaning?.status).toBe("not_meaningful");
      const served = servedRows(b);
      const withheld = [...served.values()].filter((r) => r.status === "margin_not_meaningful").map((r) => r.key);
      // Every result over turnover — one verdict a period.
      expect(withheld.sort()).toEqual([
        "pl.ebit", "pl.ebitda", "pl.gross_profit", "pl.net_income", "pl.net_income_operational", "pl.pretax",
      ]);
      renderWithProviders(mount({ tab: "pl", body: b, rows: [Y25], currentId: P25 }));
      await language(lang);
      let seen = 0;
      for (const c of shareOnlyCells()) {
        if (c.getAttribute("data-share-status") !== "margin_not_meaningful") continue;
        expect(withheld).toContain(c.getAttribute("data-cmp-key"));
        expect(c.textContent).toBe(text(lang, "statements.cmp.notMeaningful"));
        expect(c.querySelector(".cmp-cell")!.getAttribute("title")).toBe(text(lang, "statements.cmp.share.marginNotMeaningful"));
        seen += 1;
      }
      expect(seen, "no result line on screen carries the rule's word").toBeGreaterThanOrEqual(2);
      expect(cellOf("pl.ebitda")!.getAttribute("data-share-status")).toBe("margin_not_meaningful");
      // The refused margins, as percentages, are nowhere on screen.
      expect(document.body.textContent).not.toMatch(/339[.,]3\s*%|493[.,]7\s*%|301[.,]0\s*%/);
      // The base line and the cost lines keep their served shares.
      expect(cellOf("pl.revenue")!.textContent).toBe(lang === "ro" ? "100,0%" : "100.0%");
      everyShareCellIsServed(b, lang);
      noRawKeys();
      statesChecked += 1;
    });
  }

  it("a base below the zero floor gives no line of that statement a share — constructed: no committed book has the shape", async () => {
    const b = body24();
    for (const r of b.statements.common_size!.rows) {
      // The engine's shape for no base: status no_base, share null — and a
      // planted 0 in `share`, which the reader must drop.
      if (r.statement === "PL") Object.assign(r, { status: "no_base", share: 0 });
    }
    renderWithProviders(mount({ tab: "pl", body: b, rows: TWO_YEARS, currentId: P24 }));
    await language("ro");
    const cells = shareOnlyCells().filter((c) => c.getAttribute("data-cmp-key"));
    expect(cells.length).toBeGreaterThanOrEqual(8);
    for (const c of cells) {
      expect(c.getAttribute("data-share-status")).toBe("no_base");
      expect(c.textContent).toBe("fără bază");
      expect(c.querySelector(".cmp-cell")!.getAttribute("title")).toBe(text("ro", "statements.cmp.share.noBasePl"));
    }
    expect(document.body.textContent).not.toMatch(/\b0[.,]0%/);
    statesChecked += 1;
  });

  it("the reader takes a share only under the share status, and never guesses a shape", () => {
    const rows = (over: Partial<ServedRow>[]) => ({
      common_size: {
        schema: "common_size/1",
        bases: {},
        rows: over.map((o) => ({ key: "pl.x", statement: "PL", base_key: "pl.revenue", current: 5, share: 0.5, status: "share", note: "", ...o })),
      },
    });
    const one = (o: Partial<ServedRow>) => readCommonSize(rows([o]))!.rows.get(o.key ?? "pl.x");
    expect(one({})!.share).toBe(0.5);
    for (const status of ["no_base", "margin_not_meaningful", "absent", "refused", "not_disclosed_at_this_detail_level", "a_status_of_tomorrow"]) {
      expect(one({ status })!.share, status).toBeNull();
      statesChecked += 1;
    }
    expect(one({ status: "a_status_of_tomorrow" })!.status).toBe("unknown");
    expect(one({ status: "margin_not_meaningful" })!.status).toBe("margin_not_meaningful");
    expect(one({ share: Number.NaN })!.share).toBeNull();
    expect(one({ share: "0.5" as unknown as number })!.share).toBeNull();
    // Not a block: nothing is read, nothing is computed.
    expect(readCommonSize(null)).toBeNull();
    expect(readCommonSize({})).toBeNull();
    expect(readCommonSize({ common_size: null })).toBeNull();
    expect(readCommonSize({ common_size: { schema: "share_of_wallet/1", rows: [] } })).toBeNull();
    expect(readCommonSize({ common_size: { schema: "common_size/1", rows: "many" } })).toBeNull();
    const skipped = readCommonSize(rows([{ key: "" }, { statement: "CF" as "PL" }, { key: "pl.kept" }]))!;
    expect([...skipped.rows.keys()]).toEqual(["pl.kept"]);
    statesChecked += 9;
  });
});

// ── S4: "No comparison", and a one-period company ─────────────────────

describe("S4 the share box alone — the reader chose no comparison, or the company has one period", () => {
  for (const lang of ["ro", "en"] as const) {
    it(`${lang}: "No comparison": no notice, the share box alone on the P&L and the balance sheet, the column printed`, async () => {
      for (const tab of ["pl", "balance_sheet"] as const) {
        storeView({ priorPeriodId: "none" });
        const b = body25();
        const r = renderWithProviders(mount({ tab, body: b, rows: TWO_YEARS, currentId: P25 }));
        await language(lang);
        expect(controls()!.getAttribute("data-comparison")).toBe("off");
        expect(screen.getByTestId("comparatives-prior-select")).not.toBeNull();
        expect(noPriorNotice()).toBeNull();
        expect(outcomeNote()).toBeNull();
        expect(boxKeys()).toEqual(["share"]);
        expect(box("share")!.disabled).toBe(false);
        expect(box("share")!.checked).toBe(true);
        expect(box("share")!.closest("label")!.textContent).toBe(SHARE_LABEL[tab][lang]);
        expect(everyShareCellIsServed(b, lang)).toBeGreaterThanOrEqual(tab === "pl" ? 14 : 40);
        noRawKeys();
        r.unmount();
        statesChecked += 1;
      }
    });
  }

  it('"No comparison" on a tab with no share column: no boxes, as before', () => {
    for (const tab of ["cash_flow", "ratios", "overview"] as const) {
      storeView({ priorPeriodId: "none" });
      const r = renderWithProviders(mount({ tab, body: body25(), rows: TWO_YEARS, currentId: P25 }));
      expect(boxKeys(), tab).toEqual([]);
      expect(screen.queryByTestId("comparatives-columns")).toBeNull();
      r.unmount();
      statesChecked += 1;
    }
  });

  for (const lang of ["ro", "en"] as const) {
    it(`${lang}: a company with ONE period: no picker, no notice, the share box alone — and the column`, async () => {
      for (const tab of ["pl", "balance_sheet"] as const) {
        const b = body25();
        const r = renderWithProviders(mount({ tab, body: b, rows: [Y25], currentId: P25 }));
        await language(lang);
        expect(controls(), "a one-period company has no share box").not.toBeNull();
        expect(controls()!.getAttribute("data-comparison")).toBe("single");
        expect(screen.queryByTestId("comparatives-prior-select"), "a picker with nothing to pick").toBeNull();
        expect(noPriorNotice(), "a notice where nothing claims a comparison").toBeNull();
        expect(boxKeys()).toEqual(["share"]);
        expect(box("share")!.disabled).toBe(false);
        expect(box("share")!.checked).toBe(true);
        expect(everyShareCellIsServed(b, lang)).toBeGreaterThanOrEqual(tab === "pl" ? 14 : 40);
        noRawKeys();
        r.unmount();
        statesChecked += 1;
      }
    });
  }

  it("a one-period company on a tab with no share column renders no controls at all, as before", () => {
    for (const tab of ["overview", "cash_flow", "ratios"] as const) {
      const r = renderWithProviders(mount({ tab, body: body25(), rows: [Y25], currentId: P25 }));
      expect(controls(), tab).toBeNull();
      r.unmount();
      statesChecked += 1;
    }
  });
});

// ── S4: a company whose period list is not known ──────────────────────

describe("S4 the share box is there whenever the column is — the company's period list unknown", () => {
  // The list still loading, failed, or the period's company not the one
  // open: the page knows the period on screen and nothing about the others.
  // The column was painted with no box to switch it off (review 2026-10-04).
  for (const tab of ["pl", "balance_sheet"] as const) {
    it(`${tab}: the share box alone, enabled — and unticking it removes the column`, () => {
      const b = body25();
      renderWithProviders(mount({ tab, body: b, rows: TWO_YEARS, currentId: P25, company: "unknown" }));
      expect(controls(), "a share column on screen and no control for it").not.toBeNull();
      expect(controls()!.getAttribute("data-comparison")).toBe("single");
      expect(screen.queryByTestId("comparatives-prior-select")).toBeNull();
      expect(noPriorNotice()).toBeNull();
      expect(outcomeNote()).toBeNull();
      expect(boxKeys()).toEqual(["share"]);
      expect(box("share")!.disabled).toBe(false);
      expect(everyShareCellIsServed(b, "en")).toBeGreaterThanOrEqual(tab === "pl" ? 14 : 40);
      fireEvent.click(box("share")!);
      expect(shareOnlyCells()).toEqual([]);
      statesChecked += 1;
    });
  }

  it("on a tab with no share column of its own there is nothing to control: no controls", () => {
    for (const tab of ["overview", "cash_flow", "ratios"] as const) {
      const r = renderWithProviders(mount({ tab, body: body25(), rows: TWO_YEARS, currentId: P25, company: "unknown" }));
      expect(controls(), tab).toBeNull();
      r.unmount();
      statesChecked += 1;
    }
  });

  it("the composition: which tabs carry the controls and the notes, and what each statement's provider is handed", () => {
    const b = body25();
    const base = {
      statements: b.statements,
      rendersCanonicalBs: true,
      periods: companyOf(TWO_YEARS).periods,
      currentId: P25,
      currentEnd: Y25.end,
      autoPick: null,
      priorId: P24,
      stored: null,
      columns: { prior: true, delta: false, deltaPct: true, share: true },
      doc: forward().comparatives,
      outcome: { kind: "served" } as const,
    };
    expect([...COMPARISON_TABS]).toEqual(["overview", "pl", "balance_sheet", "cash_flow", "ratios"]);
    expect([...VERDICT_TABS]).toEqual(["pl", "balance_sheet", "ratios"]);
    for (const tab of ["overview", "pl", "balance_sheet", "cash_flow", "ratios", "valuation", "risks", "export"]) {
      const on = COMPARISON_TABS.includes(tab);
      const sf = comparisonSurfaceOf({ ...base, tab });
      expect([sf.controlsShown, sf.notesShown], tab).toEqual([on, on]);
      // One period, or none known: controls (the share box), no notes.
      const one = comparisonSurfaceOf({ ...base, tab, periods: companyOf([Y25]).periods });
      expect([one.controlsShown, one.notesShown], `${tab} · one period`).toEqual([on, false]);
      const none = comparisonSurfaceOf({ ...base, tab, periods: [] });
      expect([none.controlsShown, none.notesShown], `${tab} · periods unknown`).toEqual([on, false]);
      // Nothing loaded: nothing rendered.
      const empty = comparisonSurfaceOf({ ...base, tab, statements: null });
      expect([empty.controlsShown, empty.notesShown, empty.commonSize], `${tab} · nothing loaded`).toEqual([false, false, null]);
      statesChecked += 4;
    }
    // What each statement's provider is handed.
    const sf = comparisonSurfaceOf({ ...base, tab: "pl" });
    expect(sf.commonSize).not.toBeNull();
    expect(statementComparisonOf(sf, "pl")).toEqual({ doc: base.doc, columns: base.columns, statement: "PL", commonSize: sf.commonSize });
    expect(statementComparisonOf(sf, "balance_sheet")).toEqual({ doc: base.doc, columns: base.columns, statement: "BS", commonSize: sf.commonSize });
    // The cash flow has no share column: no block, the columns as stored.
    expect(statementComparisonOf(sf, "cash_flow")).toEqual({ doc: base.doc, columns: base.columns, statement: "PL", commonSize: null });
    // A tab that cannot paint its share column is handed NO share column.
    const legacy = comparisonSurfaceOf({ ...base, tab: "balance_sheet", rendersCanonicalBs: false });
    expect(statementComparisonOf(legacy, "balance_sheet")).toEqual({
      doc: base.doc, columns: { ...base.columns, share: false }, statement: "BS", commonSize: null,
    });
    expect(statementComparisonOf(legacy, "pl").commonSize).toBe(legacy.commonSize);
    const bare = comparisonSurfaceOf({ ...base, tab: "pl", statements: { currency: "RON" } });
    expect(statementComparisonOf(bare, "pl")).toEqual({
      doc: base.doc, columns: { ...base.columns, share: false }, statement: "PL", commonSize: null,
    });
    // The reader's stored columns are never written: a new object, the old one intact.
    expect(base.columns).toEqual({ prior: true, delta: false, deltaPct: true, share: true });
    statesChecked += 7;
  });
});

// ── S4: a legacy balance sheet ────────────────────────────────────────

describe("S4 a balance sheet with no canonical rows has no share column — and says why", () => {
  /** What the engine serves for a period with no canonical object
   *  (gate common-size-single): the registry lines alone — CONSTRUCTED by
   *  removing the canonical object and its rows from the committed bytes. */
  const legacy = (b: Body): Body => {
    delete (b.statements as unknown as Record<string, unknown>).canonical_bs;
    b.statements.common_size!.rows = b.statements.common_size!.rows.filter(
      (r) => !/^bs\.(row|section|total)\./.test(r.key),
    );
    return b;
  };
  const legacyDoc: Answers = (cur, prior) => {
    const answer = SERVED(cur, prior);
    if (answer?.kind !== "ok") return answer;
    answer.data.common_size = answer.data.common_size.filter((r) => !/^bs\.(row|section|total)\./.test(r.key));
    answer.data.prior_canonical_bs = null;
    return answer;
  };

  for (const lang of ["ro", "en"] as const) {
    it(`${lang}: with no comparison — no column of blank cells, the box off with its reason`, async () => {
      for (const [rows, stored] of [[[Y25], null], [TWO_YEARS, "none"]] as const) {
        if (stored) storeView({ priorPeriodId: stored });
        const r = renderWithProviders(mount({ tab: "balance_sheet", body: legacy(body25()), rows: [...rows], currentId: P25 }));
        await language(lang);
        const statement = screen.getByTestId("bs-statement");
        expect(statement.getAttribute("data-share-only"), "a share-only layout with nothing to paint").toBeNull();
        expect(screen.queryByTestId("bs-share-header")).toBeNull();
        expect(shareOnlyCells()).toEqual([]);
        expect(boxKeys()).toEqual(["share"]);
        expect(box("share")!.disabled && !box("share")!.checked).toBe(true);
        expect(screen.getByTestId("comparatives-share-unavailable").textContent).toBe(text(lang, "statements.cmp.share.notServed"));
        r.unmount();
        resetStorage();
        statesChecked += 1;
      }
    });

    it(`${lang}: with a comparison, and with no prior — the share box says the shares are not available, never the missing prior`, async () => {
      for (const [current, body] of [[P25, body25()], [P24, body24()]] as const) {
        const r = renderWithProviders(
          mount({ tab: "balance_sheet", body: legacy(body), rows: TWO_YEARS, currentId: current, answers: legacyDoc }),
        );
        await language(lang);
        expect(controls()!.getAttribute("data-comparison")).toBe(current === P25 ? "on" : "no-prior");
        expect(box("share")!.disabled && !box("share")!.checked, "a share box ticked over a column nothing can paint").toBe(true);
        expect(box("share")!.getAttribute("aria-describedby")).toBe(COMPARATIVES_SHARE_NOTE_ID);
        expect(screen.getByTestId("comparatives-share-unavailable").textContent).toBe(text(lang, "statements.cmp.share.notServed"));
        expect(screen.queryByTestId("bs-share-header"), "a share header over blank cells").toBeNull();
        expect(shareOnlyCells()).toEqual([]);
        // The reader's choice is not written over.
        expect(readComparativesView(ORG).columns.share).toBe(true);
        r.unmount();
        statesChecked += 1;
      }
    });
  }
});

// ── S4: a payload without the block ───────────────────────────────────

describe("S4 a payload without the block — the box is off with a reason, and nothing is computed", () => {
  const withoutBlock = (b: Body): Body => {
    delete (b.statements as unknown as Record<string, unknown>).common_size;
    return b;
  };

  for (const lang of ["ro", "en"] as const) {
    it(`${lang}: the share box alone is off, unticked, and says why beside it; no column`, async () => {
      for (const [rows, stored] of [[[Y25], null], [TWO_YEARS, "none"]] as const) {
        for (const tab of ["pl", "balance_sheet"] as const) {
          if (stored) storeView({ priorPeriodId: stored });
          const r = renderWithProviders(mount({ tab, body: withoutBlock(body25()), rows: [...rows], currentId: P25 }));
          await language(lang);
          expect(boxKeys()).toEqual(["share"]);
          expect(box("share")!.disabled, "a share box is on with no block to paint it from").toBe(true);
          expect(box("share")!.checked).toBe(false);
          const why = screen.getByTestId("comparatives-share-unavailable");
          expect(why.textContent).toBe(text(lang, "statements.cmp.share.notServed"));
          expect(why.id).toBe(COMPARATIVES_SHARE_NOTE_ID);
          expect(box("share")!.getAttribute("aria-describedby")).toBe(COMPARATIVES_SHARE_NOTE_ID);
          expect(shareOnlyCells()).toEqual([]);
          expect(document.querySelectorAll(".cmp-cell").length).toBe(0);
          // The reader's choice is not written over.
          expect(readComparativesView(ORG).columns.share).toBe(true);
          noRawKeys();
          r.unmount();
          resetStorage();
          statesChecked += 1;
        }
      }
    });
  }

  it("with no prior and no block the four boxes are off — and the share box says ITS reason, not the missing prior", async () => {
    for (const lang of ["ro", "en"] as const) {
      const r = renderWithProviders(mount({ tab: "pl", body: withoutBlock(body24()), rows: TWO_YEARS, currentId: P24 }));
      await language(lang);
      for (const k of ["prior", "delta", "deltaPct", "share"]) expect(box(k)!.disabled && !box(k)!.checked, k).toBe(true);
      for (const k of ["prior", "delta", "deltaPct"]) {
        expect(box(k)!.getAttribute("aria-describedby")).toBe(COMPARATIVES_NO_PRIOR_NOTE_ID);
      }
      // The three wait for a prior; the share box is off because the payload
      // carries no shares — uploading a prior would not bring it back.
      expect(box("share")!.getAttribute("aria-describedby")).toBe(COMPARATIVES_SHARE_NOTE_ID);
      expect(screen.getByTestId("comparatives-share-unavailable").textContent).toBe(
        text(lang, "statements.cmp.share.notServed"),
      );
      expect(shareOnlyCells()).toEqual([]);
      r.unmount();
      statesChecked += 1;
    }
  });

  it("what a tab can paint: the P&L from any block; the balance sheet only from canonical rows it renders", () => {
    const block = readCommonSize(body25().statements);
    expect(shareOfferOf("pl", block, true)).toEqual({ base: "PL", served: true });
    expect(shareOfferOf("pl", null, true)).toEqual({ base: "PL", served: false });
    expect(shareOfferOf("balance_sheet", block, true)).toEqual({ base: "BS", served: true });
    expect(shareOfferOf("balance_sheet", block, false)).toEqual({ base: "BS", served: false });
    const registryOnly = readCommonSize({
      common_size: {
        schema: "common_size/1",
        rows: body25().statements.common_size!.rows.filter((r) => !/^bs\.(row|section|total)\./.test(r.key)),
      },
    });
    expect(shareOfferOf("balance_sheet", registryOnly, true)).toEqual({ base: "BS", served: false });
    for (const tab of ["overview", "cash_flow", "ratios", "valuation"]) expect(shareOfferOf(tab, block, true)).toBeNull();
    statesChecked += 9;
  });
});

// ── S4: with a document, nothing changed — and one figure per page ────

describe("S4 with a comparison document — the columns are the document's, and its share is the block's", () => {
  const docShare = (cells: HTMLElement) => {
    const share = [...cells.querySelectorAll<HTMLElement>(":scope > .cmp-cell")].at(-1)!;
    return { text: share.childNodes[0]?.textContent ?? "", pts: share.querySelector(".cmp-cell--pts")?.textContent?.trim() ?? null };
  };

  for (const lang of ["ro", "en"] as const) {
    it(`${lang} · P&L: four columns, and every share cell prints the document's current_share — the block's own figure`, async () => {
      const p = forward();
      renderWithProviders(mount({ tab: "pl", body: p.current_body, rows: TWO_YEARS, currentId: P25 }));
      await language(lang);
      expect(controls()!.getAttribute("data-comparison")).toBe("on");
      expect(boxKeys()).toEqual(["prior", "delta", "deltaPct", "share"]);
      for (const k of boxKeys()) expect(box(k)!.disabled === false && box(k)!.checked).toBe(true);
      expect(screen.getByTestId("pl-statement").getAttribute("data-comparative")).toBe(P24);
      expect(screen.getByTestId("pl-statement").getAttribute("data-share-only")).toBeNull();
      expect(plHeader()!.children.length).toBe(6);
      expect(shareOnlyCells()).toEqual([]);

      const block = servedRows(p.current_body);
      const doc = new Map(p.comparatives.common_size.map((r) => [r.key, r]));
      let printed = 0;
      for (const cells of document.querySelectorAll<HTMLElement>('.cmp-cells[data-cmp="compared"][data-cmp-key]')) {
        const key = cells.getAttribute("data-cmp-key")!;
        const row = doc.get(key)!;
        if (row.current_share === null) continue;
        const shown = docShare(cells);
        expect(shown.text, key).toBe(formatShare(row.current_share, lang));
        expect(shown.pts, key).toBe(formatPts(row.delta_pts, lang));
        // ONE FIGURE PER PAGE: the document's share is the period's own.
        expect(block.get(key)!.share, key).toBe(row.current_share);
        printed += 1;
      }
      expect(printed).toBeGreaterThanOrEqual(14);
      cellsChecked += printed;
      statesChecked += 1;
    });

    it(`${lang} · balance sheet: Δ % and share; the share is the document's canonical share and change in points — nothing divided`, async () => {
      const p = forward();
      renderWithProviders(mount({ tab: "balance_sheet", body: p.current_body, rows: TWO_YEARS, currentId: P25 }));
      await language(lang);
      const statement = screen.getByTestId("bs-statement");
      expect(statement.getAttribute("data-comparative")).toBe(P24);
      expect(statement.querySelectorAll(".bs-col-header .cmp-cells > span").length).toBe(2);
      const block = servedRows(p.current_body);
      const doc = new Map(p.comparatives.common_size.map((r) => [r.key, r]));
      let printed = 0;
      let gone = 0;
      for (const cells of statement.querySelectorAll<HTMLElement>('.cmp-cells[data-cmp="bs"]')) {
        const key = cells.getAttribute("data-cmp-key");
        expect(key, "a canonical row with no engine share key").not.toBeNull();
        const row = doc.get(key!)!;
        const shown = docShare(cells);
        if (row.current_share === null) {
          // A line only the prior period carries: no share, never 0 %.
          expect(shown.text, key!).toBe("—");
          gone += 1;
          continue;
        }
        expect(shown.text, key!).toBe(formatShare(row.current_share, lang));
        expect(shown.pts, key!).toBe(formatPts(row.delta_pts, lang));
        expect(block.get(key!)!.share, key!).toBe(row.current_share);
        expect(foreignNumber(shown.text, lang)).toBeNull();
        printed += 1;
      }
      expect(printed).toBeGreaterThanOrEqual(45);
      expect(gone).toBeGreaterThanOrEqual(4);
      cellsChecked += printed + gone;
      statesChecked += 1;
    });
  }

  it("the share a row prints is the same string with the document and without it", () => {
    const withDoc = new Map<string, string>();
    const p = forward();
    for (const tab of ["pl", "balance_sheet"] as const) {
      const r = renderWithProviders(mount({ tab, body: p.current_body, rows: TWO_YEARS, currentId: P25 }));
      for (const cells of document.querySelectorAll<HTMLElement>(".cmp-cells[data-cmp-key]")) {
        const d = docShare(cells);
        if (/\d/.test(d.text)) withDoc.set(cells.getAttribute("data-cmp-key")!, d.text);
      }
      r.unmount();
      storeView({ priorPeriodId: "none" });
      const alone = renderWithProviders(mount({ tab, body: p.current_body, rows: TWO_YEARS, currentId: P25 }));
      let same = 0;
      for (const c of shareOnlyCells()) {
        if (c.getAttribute("data-share-status") !== "share") continue;
        const key = c.getAttribute("data-cmp-key")!;
        expect(c.textContent, `${key}: one figure on the page with a comparison, another without`).toBe(withDoc.get(key));
        same += 1;
      }
      expect(same).toBeGreaterThanOrEqual(tab === "pl" ? 14 : 45);
      cellsChecked += same;
      alone.unmount();
      resetStorage();
    }
  });

  it("a balance-sheet row whose amount is not the block's carries no share with a document either", () => {
    const p = forward();
    p.current_body.statements.canonical_bs!.rows.find((r) => r.id === "cash_operating")!.amount += 1;
    renderWithProviders(mount({ tab: "balance_sheet", body: p.current_body, rows: TWO_YEARS, currentId: P25 }));
    const cells = document.querySelector<HTMLElement>('.cmp-cells[data-cmp-key="bs.row.cash_operating"]')!;
    expect(cells.getAttribute("data-share-status")).toBe("definition-differs");
    expect(docShare(cells).text).toBe("—");
    statesChecked += 1;
  });

  it("a pair the engine will not compare, or a line the OTHER period refused, does not blank the share of the period on screen — constructed on the committed pair", () => {
    // The engine's shape for a pair-level refusal: no share on either side
    // of the row, and no change in points (gate common-size-single holds
    // it). The period on screen still has its own share — it prints, alone.
    const KEYS = { pl: ["pl.ebitda", "pl.cogs"], balance_sheet: ["bs.row.cash_operating", "bs.section.current_assets"] } as const;
    for (const [status, every] of [["refused", false], ["incomparable", true]] as const) {
      const answers: Answers = () => {
        const doc = forward().comparatives;
        for (const r of doc.common_size) {
          if (every || (KEYS.pl as readonly string[]).includes(r.key) || (KEYS.balance_sheet as readonly string[]).includes(r.key)) {
            Object.assign(r, { status, current_share: null, prior_share: null, delta_pts: null });
          }
        }
        return { kind: "ok", data: doc };
      };
      for (const tab of ["pl", "balance_sheet"] as const) {
        const b = body25();
        const served = servedRows(b);
        const r = renderWithProviders(mount({ tab, body: b, rows: TWO_YEARS, currentId: P25, answers }));
        for (const key of KEYS[tab]) {
          const cells = document.querySelector<HTMLElement>(`.cmp-cells[data-cmp-key="${key}"]`)!;
          const shown = docShare(cells);
          expect(shown.text, `${status} ${key}: the period's own share was blanked by the pair`).toBe(
            formatShare(served.get(key)!.share, "en"),
          );
          expect(shown.pts, `${status} ${key}: points with no comparison of the line`).toBeNull();
          cellsChecked += 1;
        }
        r.unmount();
        statesChecked += 1;
      }
    }
  });

  it("the share is the PERIOD'S OWN with a document too: a document with no canonical share adds no points, and takes none away", () => {
    const answers: Answers = () => {
      const doc = forward().comparatives;
      doc.common_size = doc.common_size.filter((r) => !/^bs\.(row|section|total)\./.test(r.key));
      return { kind: "ok", data: doc };
    };
    const b = body25();
    renderWithProviders(mount({ tab: "balance_sheet", body: b, rows: TWO_YEARS, currentId: P25, answers }));
    const served = servedRows(b);
    const cells = [...document.querySelectorAll<HTMLElement>('.cmp-cells[data-cmp="bs"]')];
    expect(cells.length).toBeGreaterThanOrEqual(45);
    let printed = 0;
    for (const c of cells) {
      const key = c.getAttribute("data-cmp-key");
      const own = key ? served.get(key) : undefined;
      const shown = docShare(c);
      expect(shown.pts, `${key}: points with no document share to take them from`).toBeNull();
      if (own?.status === "share") {
        expect(shown.text, key!).toBe(formatShare(own.share, "en"));
        expect(c.getAttribute("data-share-status")).toBe("share");
        printed += 1;
      } else {
        expect(shown.text, key ?? "unmapped").toBe("—");
      }
    }
    expect(printed).toBeGreaterThanOrEqual(45);
    cellsChecked += printed;
    statesChecked += 1;
  });

  it("a payload with NO block and a document: the balance sheet has no share column, and the box says why — nothing is held to nothing", async () => {
    const bare = body25();
    delete (bare.statements as unknown as Record<string, unknown>).common_size;
    for (const tab of ["balance_sheet", "pl"] as const) {
      const r = renderWithProviders(mount({ tab, body: bare, rows: TWO_YEARS, currentId: P25 }));
      await language("ro");
      expect(controls()!.getAttribute("data-comparison")).toBe("on");
      for (const k of ["prior", "delta", "deltaPct"]) expect(box(k)!.disabled, k).toBe(false);
      expect(box("share")!.disabled && !box("share")!.checked, "a share box ticked over a column nothing can paint").toBe(true);
      expect(screen.getByTestId("comparatives-share-unavailable").textContent).toBe(text("ro", "statements.cmp.share.notServed"));
      if (tab === "balance_sheet") {
        expect(screen.queryByTestId("bs-share-header"), "a share header over blank cells").toBeNull();
        // Δ % is still there: one comparison cell a row, and it is not a share.
        expect(screen.getByTestId("bs-statement").querySelectorAll(".bs-col-header .cmp-cells > span").length).toBe(1);
      } else {
        expect(plHeader()!.children.length).toBe(5);
      }
      expect(document.querySelectorAll(".cmp-cell--pts").length, "the document's share printed with no block to hold it to").toBe(0);
      r.unmount();
      resetStorage();
      statesChecked += 1;
    }
  });
});

// ── The document describes ANOTHER book ───────────────────────────────

describe("a comparison document that describes another book paints no share — and is asked again", () => {
  // THE STATE (the pre-deploy review, 2026-10-04): the month was replaced
  // under the SAME period id. The period query was reset and refetched; the
  // comparison of (period, prior) was not — it stayed in the cache, the
  // previous book's. Here: the 2024 book served under the 2025 period's id,
  // beside the document the engine built for the 2025 book.
  const stale = () => ({ body: body24(), doc: forward().comparatives });

  for (const lang of ["ro", "en"] as const) {
    it(`${lang} · balance sheet: every share on screen is the on-screen book's own; the stale document adds nothing`, async () => {
      const { body, doc } = stale();
      renderWithProviders(mount({ tab: "balance_sheet", body, rows: TWO_YEARS, currentId: P25 }));
      await language(lang);
      // The premise: the document IS on screen, and is the other book's.
      expect(screen.getByTestId("bs-statement").getAttribute("data-comparative")).toBe(P24);
      const own = servedRows(body);
      const theirs = new Map(doc.common_size.map((r) => [r.key, r]));
      let printed = 0;
      let differs = 0;
      for (const cells of document.querySelectorAll<HTMLElement>('.cmp-cells[data-cmp="bs"]')) {
        const key = cells.getAttribute("data-cmp-key")!;
        const share = [...cells.querySelectorAll<HTMLElement>(":scope > .cmp-cell")].at(-1)!;
        const shown = share.childNodes[0]?.textContent ?? "";
        const pts = share.querySelector(".cmp-cell--pts");
        if (!/\d/.test(shown)) continue;
        const mine = own.get(key);
        expect(mine?.status, `${key}: a share printed for a line the on-screen book does not serve`).toBe("share");
        expect(shown, `${key}: not the on-screen book's own share`).toBe(formatShare(mine!.share, lang));
        const other = theirs.get(key);
        if (other && other.current_share !== mine!.share) {
          // The document's figure is another book's: none of it is printed.
          expect(pts, `${key}: the stale document's change in points`).toBeNull();
          if (other.current_share !== null) {
            expect(cells.getAttribute("data-share-status")).toBe("document-differs");
            differs += 1;
          }
        }
        printed += 1;
      }
      expect(printed).toBeGreaterThanOrEqual(40);
      expect(differs, "the two books' shares do not differ — the witness is vacuous").toBeGreaterThanOrEqual(30);
      cellsChecked += printed;
      statesChecked += 1;
    });
  }

  for (const lang of ["ro", "en"] as const) {
    it(`${lang} · P&L: the row guard blanks the stale document's prior, Δ and Δ % on every keyed row — and the share cell is the on-screen book's own`, async () => {
      // (Until the second review the share cell was blanked with the three
      // comparison cells: on the P&L a document the row could not be held to
      // took the period's own share off the screen, where "No comparison"
      // printed it — and where the balance sheet, in this very state, did.)
      const { body } = stale();
      renderWithProviders(mount({ tab: "pl", body, rows: TWO_YEARS, currentId: P25 }));
      await language(lang);
      const own = servedRows(body);
      const keyed = [...document.querySelectorAll<HTMLElement>(".cmp-cells[data-cmp-key]")];
      expect(keyed.length).toBeGreaterThanOrEqual(12);
      const blank = keyed.filter((c) => c.getAttribute("data-cmp") === "definition-differs");
      expect(blank.length).toBeGreaterThanOrEqual(12);
      let printed = 0;
      for (const c of blank) {
        const key = c.getAttribute("data-cmp-key")!;
        const cells = [...c.querySelectorAll<HTMLElement>(":scope > .cmp-cell")];
        expect(cells.length, key).toBe(4);
        // prior, Δ, Δ %: nothing of the document's, and the reason.
        for (const cell of cells.slice(0, 3)) {
          expect(cell.textContent, key).not.toMatch(/\d/);
          expect(cell.getAttribute("title"), key).toBe(text(lang, "statements.cmp.definitionDiffers"));
        }
        // the share: the on-screen book's own, with no points of the document's.
        const share = cells[3];
        const mine = own.get(key);
        expect(share.querySelector(".cmp-cell--pts"), `${key}: the stale document's change in points`).toBeNull();
        if (c.getAttribute("data-share-status") === "share") {
          expect(mine?.status, key).toBe("share");
          expect(share.textContent, `${key}: not the on-screen book's own share`).toBe(formatShare(mine!.share, lang));
          printed += 1;
        } else {
          expect(share.textContent, key).not.toMatch(/\d/);
        }
      }
      expect(printed, "no own share printed beside the blanked comparison").toBeGreaterThanOrEqual(10);
      cellsChecked += printed;
      // A row with NO engine line says why in its share cell (it was a bare
      // gap on the P&L, where the balance sheet said it).
      const unmapped = [...document.querySelectorAll<HTMLElement>('.cmp-cells[data-cmp="unmapped"]')];
      expect(unmapped.length).toBeGreaterThanOrEqual(1);
      for (const c of unmapped) {
        const share = [...c.querySelectorAll<HTMLElement>(":scope > .cmp-cell")].at(-1)!;
        if (c.getAttribute("data-share-status") !== "unmapped") continue;
        expect(share.getAttribute("title")).toBe(text(lang, "statements.cmp.share.unavailable"));
      }
      statesChecked += 1;
    });
  }

  it("resetting a period resets every comparison that names it, on either side — and no other", () => {
    expect(comparisonNamesPeriod(comparativesQueryKey(ORG, P25, P24), P25)).toBe(true);
    expect(comparisonNamesPeriod(comparativesQueryKey(ORG, P25, P24), P24)).toBe(true);
    expect(comparisonNamesPeriod(comparativesQueryKey(ORG, P25, P24), "p-other")).toBe(false);
    expect(comparisonNamesPeriod(comparativesQueryKey(P25, "a", "b"), P25), "the company is not a period").toBe(false);
    expect(comparisonNamesPeriod(periodQueryKey(P25), P25), "a period query is not a comparison").toBe(false);

    const client = new QueryClient({ defaultOptions: appQueryClient.getDefaultOptions() });
    const answered = { kind: "ok", data: {} };
    client.setQueryData(periodQueryKey(P25), answered);
    client.setQueryData(periodQueryKey(P24), answered);
    client.setQueryData(comparativesQueryKey(ORG, P25, P24), answered);
    client.setQueryData(comparativesQueryKey(ORG, P24, P25), answered);
    client.setQueryData(comparativesQueryKey(ORG, P24, "p-2023"), answered);
    resetPeriodAnswers(client, P25);
    expect(client.getQueryData(periodQueryKey(P25)), "the period's own answer").toBeUndefined();
    expect(client.getQueryData(comparativesQueryKey(ORG, P25, P24)), "the comparison OF the period").toBeUndefined();
    expect(client.getQueryData(comparativesQueryKey(ORG, P24, P25)), "a comparison WITH the period").toBeUndefined();
    // …what does not name it is not touched.
    expect(client.getQueryData(periodQueryKey(P24))).toEqual(answered);
    expect(client.getQueryData(comparativesQueryKey(ORG, P24, "p-2023"))).toEqual(answered);
    statesChecked += 10;
  });

  it("with the app's own query defaults: the book changes under the id, the period is reset — and the comparison is asked again", async () => {
    const asked: string[] = [];
    let book: "A" | "B" = "A";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        asked.push(String(input));
        const doc = forward().comparatives;
        // Book B's document says so where the page can see it.
        doc.current = { ...doc.current, label: `book ${book}` };
        return new Response(JSON.stringify(doc), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    const client = new QueryClient({ defaultOptions: appQueryClient.getDefaultOptions() });
    function Page() {
      const query = useComparatives(P25, P24, ORG);
      const label = query.data?.kind === "ok" ? query.data.data.current.label : "none";
      return <span data-testid="doc-of">{label}</span>;
    }
    render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("doc-of").textContent).toBe("book A"), { timeout: 10_000 });
    expect(asked.length).toBe(1);

    book = "B";
    // What every same-id path used to do: the period alone. The comparison
    // stays the previous book's, and nothing ever asks again.
    await act(async () => { await client.resetQueries({ queryKey: periodQueryKey(P25) }); });
    await act(async () => { await new Promise((res) => setTimeout(res, 50)); });
    expect(asked.length, "the premise: resetting the period alone asks no comparison").toBe(1);
    expect(screen.getByTestId("doc-of").textContent).toBe("book A");

    // What every same-id path does now.
    act(() => { resetPeriodAnswers(client, P25); });
    await waitFor(() => expect(screen.getByTestId("doc-of").textContent).toBe("book B"), { timeout: 10_000 });
    expect(asked.length, "the comparison was not asked again").toBe(2);
    expect(asked[1]).toBe(asked[0]);
    statesChecked += 3;
  });
});

// ── S4: the stored columns survive ────────────────────────────────────

describe("S4 the reader's stored columns are the same key in every state, and no state writes them", () => {
  it("document → no prior → no comparison → one period → no block: read, never written", () => {
    const stored = { prior: true, delta: false, deltaPct: true, share: true };
    storeView({ priorPeriodId: null, columns: stored });
    const at = (props: Parameters<typeof Dashboard>[0]) => mount(props);
    const r = renderWithProviders(at({ tab: "pl", body: body25(), rows: TWO_YEARS, currentId: P25 }));
    expect(boxKeys().map((k) => box(k)!.checked)).toEqual([true, false, true, true]);

    r.rerender(at({ tab: "pl", body: body24(), rows: TWO_YEARS, currentId: P24 }));
    expect(boxKeys().map((k) => [box(k)!.disabled, box(k)!.checked])).toEqual([
      [true, false], [true, false], [true, false], [false, true],
    ]);
    expect(readComparativesView(ORG).columns).toEqual(stored);

    r.rerender(at({ tab: "pl", body: body24(), rows: [Y24], currentId: P24 }));
    expect(boxKeys()).toEqual(["share"]);
    expect(readComparativesView(ORG).columns).toEqual(stored);

    const bare = body24();
    delete (bare.statements as unknown as Record<string, unknown>).common_size;
    r.rerender(at({ tab: "pl", body: bare, rows: [Y24], currentId: P24 }));
    expect(box("share")!.checked).toBe(false);
    expect(readComparativesView(ORG).columns).toEqual(stored);

    r.rerender(at({ tab: "pl", body: body25(), rows: TWO_YEARS, currentId: P25 }));
    expect(boxKeys().map((k) => box(k)!.checked)).toEqual([true, false, true, true]);
    expect(readComparativesView(ORG).columns).toEqual(stored);
    statesChecked += 5;
  });

  it("the boxes, as a function: every comparison state × what the tab can paint × the stored share", () => {
    const columns = (share: boolean) => ({ prior: true, delta: false, deltaPct: true, share });
    const offers: (ShareOffer | null)[] = [null, { base: "PL", served: true }, { base: "BS", served: false }];
    for (const share of [true, false]) {
      for (const offer of offers) {
        // A tab that HAS a share column and cannot paint it: the box is off
        // with THAT reason, in every state — never ticked over blank cells.
        const cannotPaint = offer !== null && !offer.served;
        const notServed = { key: "share", enabled: false, checked: false, reason: "share_not_served" };
        // A comparison on screen, or on its way: the three as stored.
        expect(columnBoxesOf({ block: null, share: offer, columns: columns(share) })).toEqual([
          { key: "prior", enabled: true, checked: true, reason: null },
          { key: "delta", enabled: true, checked: false, reason: null },
          { key: "deltaPct", enabled: true, checked: true, reason: null },
          cannotPaint ? notServed : { key: "share", enabled: true, checked: share, reason: null },
        ]);
        // Each reason is its own: a refusal is not "still loading".
        for (const block of ["no_prior", "refused", "failed"] as const) {
          const boxes = columnBoxesOf({ block, share: offer, columns: columns(share) });
          expect(boxes.slice(0, 3).map((b) => [b.enabled, b.checked, b.reason])).toEqual([
            [false, false, block], [false, false, block], [false, false, block],
          ]);
          expect(boxes[3]).toEqual(
            cannotPaint
              ? notServed
              : offer?.served
                ? { key: "share", enabled: true, checked: share, reason: null }
                : { key: "share", enabled: false, checked: false, reason: block },
          );
        }
        expect(columnBoxesOf({ block: "off", share: offer, columns: columns(share) })).toEqual(
          offer === null
            ? []
            : offer.served
              ? [{ key: "share", enabled: true, checked: share, reason: null }]
              : [{ key: "share", enabled: false, checked: false, reason: "share_not_served" }],
        );
        statesChecked += 5;
      }
    }
    const blockOf = (stored: string | null | "none", priorId: string | null, kind: string, hasOtherPeriods = true) =>
      comparisonBlockOf({ stored, priorId, outcome: { kind } as never, hasOtherPeriods });
    expect(blockOf(null, P24, "served")).toBeNull();
    expect(blockOf(null, P24, "pending")).toBeNull();
    expect(blockOf(null, null, "none")).toBe("no_prior");
    expect(blockOf("none", null, "none")).toBe("off");
    expect(blockOf(null, P24, "refused")).toBe("refused");
    expect(blockOf(null, P24, "failed")).toBe("failed");
    expect(blockOf(null, null, "none", false)).toBe("off");
    statesChecked += 7;
  });
});

/** The dashboard's Ratios tab for one served pair (the page's own tab
 *  component, over the served ratio documents). */
function renderRatiosTab(p: Pair, saidByPage: boolean) {
  const statements = p.current_body.statements;
  const metricsByName: Record<string, number | null> = {};
  for (const m of p.current_body.metrics) metricsByName[m.name] = typeof m.value === "number" ? m.value : null;
  const ratios = computeRatios(
    statements,
    { ebitdaMargin: metricsByName.ebitda_margin ?? null, netMargin: metricsByName.net_margin ?? null },
    metricsByName,
  );
  const env = servedCreditEnvelopes(p.current_body.assembled_metrics, statements, metricsByName);
  const credit = computeCreditScore(statements, env.credit, env.piotroski, env.metricsByName);
  const view = buildRatioCompareView({
    periodTable: readRatioTable(p.current_body.assembled_metrics),
    comparativesDoc: p.comparatives,
    currentLabel: statements.periodLabel ?? "",
  })!;
  return renderWithProviders(
    <RatioCompareCtx.Provider value={view}>
      <RatiosTabContent ratios={ratios} statements={statements} altman={altmanRatio(credit)} comparisonSaidByPage={saidByPage} />
    </RatioCompareCtx.Provider>,
  );
}

// ── S5: a later "prior" reads backwards ───────────────────────────────

describe("S5 a comparison period that closes LATER reads backwards — and is said to", () => {
  const SENTENCE: Record<Lang, Record<"verdicts" | "plain", string>> = {
    en: {
      verdicts:
        "The comparison period (Dec 2025) closes after the period on screen (Dec 2024), so every change reads backwards in time and nothing is called improved or deteriorated.",
      plain:
        "The comparison period (Dec 2025) closes after the period on screen (Dec 2024), so every change reads backwards in time.",
    },
    ro: {
      verdicts:
        "Perioada de comparație (dec. 2025) se încheie după perioada afișată (dec. 2024), așa că fiecare diferență se citește înapoi în timp și nimic nu este numit îmbunătățit sau deteriorat.",
      plain:
        "Perioada de comparație (dec. 2025) se încheie după perioada afișată (dec. 2024), așa că fiecare diferență se citește înapoi în timp.",
    },
  };

  it("the fixture: the engine says the prior is later and serves no verdict", () => {
    const doc = later().comparatives;
    expect(doc.direction?.order).toBe("prior_is_later");
    expect(doc.movers.verdicts_withheld).toBe("prior_is_later");
    expect(doc.movers.improved).toEqual([]);
    expect(doc.movers.top.length).toBeGreaterThan(0);
    expect(comparisonBackwardsOf(doc)).toBe("prior_is_later");
    expect(priorIsEarlier(doc)).toBe(false);
    expect(comparisonBackwardsOf(forward().comparatives)).toBeNull();
    expect(priorIsEarlier(forward().comparatives)).toBe(true);
    statesChecked += 1;
  });

  for (const lang of ["ro", "en"] as const) {
    it(`${lang}: one sentence under the controls on every tab — with the verdict clause where the movers are`, async () => {
      for (const tab of TABS) {
        storeView({ priorPeriodId: P25 });
        const r = renderWithProviders(mount({ tab, body: body24(), rows: TWO_YEARS, currentId: P24 }));
        await language(lang);
        expect(controls()!.getAttribute("data-comparison")).toBe("on");
        expect(noPriorNotice()).toBeNull();
        const note = outcomeNote();
        expect(note, `${tab}: a comparison that reads backwards, and no word about it`).not.toBeNull();
        expect(note!.getAttribute("data-outcome")).toBe("backwards");
        expect(note!.getAttribute("data-order")).toBe("prior_is_later");
        // The clause "nothing is called improved or deteriorated" is said
        // where such a list would be: the movers (P&L, balance sheet) and
        // the band movements (Ratios).
        expect(note!.textContent).toBe(SENTENCE[lang][VERDICT_TABS.includes(tab) ? "verdicts" : "plain"]);
        expect(screen.getAllByTestId("comparatives-outcome").length).toBe(1);
        // A period that closes later is not a "prior": the box says so too.
        if (tab !== "overview") {
          expect(box("prior")!.closest("label")!.textContent).toBe(text(lang, "statements.cmp.colComparison"));
        }
        noRawKeys();
        r.unmount();
        resetStorage();
        statesChecked += 1;
      }
    });

    it(`${lang}: no improved / deteriorated list, and the bridge names each period by its own month`, async () => {
      for (const tab of ["pl", "balance_sheet"] as const) {
        storeView({ priorPeriodId: P25 });
        const r = renderWithProviders(mount({ tab, body: body24(), rows: TWO_YEARS, currentId: P24 }));
        await language(lang);
        const summary = screen.getByTestId(`comparatives-summary-${tab === "pl" ? "pl" : "bs"}`);
        expect(summary.getAttribute("data-verdicts")).toBe("withheld");
        expect(screen.queryByTestId("cmp-improved"), "an improved list under a later comparison period").toBeNull();
        expect(screen.queryByTestId("cmp-deteriorated")).toBeNull();
        // The movers themselves — the figures — are still listed.
        expect(within(screen.getByTestId("cmp-movers")).queryAllByRole("listitem").length).toBeGreaterThan(0);
        const [prior, current] = lang === "ro" ? ["dec. 2025", "dec. 2024"] : ["Dec 2025", "Dec 2024"];
        const from = screen.getAllByTestId("cmp-bridge-from").map((e) => e.textContent ?? "");
        const to = screen.getAllByTestId("cmp-bridge-to").map((e) => e.textContent ?? "");
        expect(from.length).toBe(tab === "pl" ? 1 : 2);
        for (const s of from) {
          expect(s.endsWith(` — ${prior}`), s).toBe(true);
          expect(s, "a later period called prior").not.toMatch(/prior|anterior|current|curent/i);
        }
        for (const s of to) {
          expect(s.endsWith(` — ${current}`), s).toBe(true);
          expect(s).not.toMatch(/prior|anterior|current|curent/i);
        }
        r.unmount();
        resetStorage();
        statesChecked += 1;
      }
    });
  }

  it('a line one period lacks is not called "new" or "no longer present" when the comparison period is the later one', async () => {
    const WORDS: Record<Lang, Record<"new" | "gone" | "here" | "there", string>> = {
      en: { new: "new", gone: "no longer present", here: "only in this period", there: "only in the comparison" },
      ro: { new: "nou", gone: "nu mai apare", here: "doar în perioada afișată", there: "doar în comparație" },
    };
    const words = () =>
      [...screen.getByTestId("bs-statement").querySelectorAll<HTMLElement>(".cmp-cell--word")].map((e) => e.textContent ?? "");
    const count = (all: string[], w: string) => all.filter((x) => x === w).length;
    for (const lang of ["en", "ro"] as const) {
      const w = WORDS[lang];
      // The later period as the comparison: the words say WHERE the line is.
      storeView({ priorPeriodId: P25 });
      const back = renderWithProviders(mount({ tab: "balance_sheet", body: body24(), rows: TWO_YEARS, currentId: P24 }));
      await language(lang);
      let seen = words();
      expect(count(seen, w.new), `${lang}: a line the LATER period lacks is called "${w.new}"`).toBe(0);
      expect(count(seen, w.gone)).toBe(0);
      expect(count(seen, w.here)).toBeGreaterThanOrEqual(4);
      expect(count(seen, w.there)).toBeGreaterThanOrEqual(1);
      const [here, there] = [count(seen, w.here), count(seen, w.there)];
      // The bridge's steps carry the same words on a line one period lacks.
      const step = (status: string) =>
        [...document.querySelectorAll<HTMLElement>(`[data-step-status="${status}"] > span:first-child`)].map((e) => e.textContent ?? "");
      expect(step("new").length + step("gone").length).toBeGreaterThanOrEqual(2);
      for (const t of step("new")) expect(t.endsWith(w.here), t).toBe(true);
      for (const t of step("gone")) expect(t.endsWith(w.there), t).toBe(true);
      back.unmount();
      resetStorage();
      // Forward, the same lines read the other way round — and say so.
      const fwd = renderWithProviders(mount({ tab: "balance_sheet", body: body25(), rows: TWO_YEARS, currentId: P25 }));
      await language(lang);
      seen = words();
      expect(count(seen, w.here) + count(seen, w.there)).toBe(0);
      expect(count(seen, w.gone)).toBe(here);
      expect(count(seen, w.new)).toBe(there);
      fwd.unmount();
      statesChecked += 2;
    }
    expect(absentLineWordKey("absent_prior", true)).toBe("statements.cmp.new");
    expect(absentLineWordKey("absent_current", true)).toBe("statements.cmp.gone");
    expect(absentLineWordKey("absent_prior", false)).toBe("statements.cmp.onlyCurrent");
    expect(absentLineWordKey("absent_current", false)).toBe("statements.cmp.onlyComparison");
  });

  it("forward: no sentence, the lists as served, the bridge says prior / current", async () => {
    const p = forward();
    for (const lang of ["en", "ro"] as const) {
      const r = renderWithProviders(mount({ tab: "pl", body: p.current_body, rows: TWO_YEARS, currentId: P25 }));
      await language(lang);
      expect(outcomeNote()).toBeNull();
      expect(screen.getByTestId("comparatives-summary-pl").getAttribute("data-verdicts")).toBe("served");
      const names = (id: string) => [...screen.getByTestId(id).querySelectorAll("li")].map((li) => li.textContent);
      expect(names("cmp-improved")).toEqual(p.comparatives.movers.improved.filter((m) => m.statement === "PL").map((m) => m.label));
      expect(names("cmp-deteriorated")).toEqual(
        p.comparatives.movers.deteriorated.filter((m) => m.statement === "PL").map((m) => m.label),
      );
      expect(names("cmp-improved").length).toBeGreaterThan(0);
      expect(screen.getByTestId("cmp-bridge-from").textContent).toMatch(lang === "ro" ? / — anterior$/ : / — prior$/);
      expect(screen.getByTestId("cmp-bridge-to").textContent).toMatch(lang === "ro" ? / — curent$/ : / — current$/);
      // The floor is the served fraction through the one printer, and the
      // base is named in the reader's language (it read "din % din venituri").
      const floor = formatShare(p.comparatives.movers.materiality_floor, lang)!;
      expect(foreignNumber(floor, lang)).toBeNull();
      expect(screen.getByTestId("cmp-movers").textContent).toContain(
        text(lang, "statements.cmp.belowFloor")
          .replace("{{n}}", String(p.comparatives.movers.below_floor))
          .replace("{{floor}}", floor)
          .replace("{{base}}", lang === "ro" ? "venituri" : "revenue"),
      );
      r.unmount();

      // The balance sheet's movers: each materiality is the served fraction.
      const bs = renderWithProviders(mount({ tab: "balance_sheet", body: p.current_body, rows: TWO_YEARS, currentId: P25 }));
      await language(lang);
      const top = p.comparatives.movers.top.filter((m) => m.statement === "BS");
      expect(top.length).toBeGreaterThan(0);
      for (const m of top) {
        const row = document.querySelector<HTMLElement>(`[data-mover="${m.key}"]`)!;
        expect(row.textContent, m.key).toContain(
          `${formatShare(m.materiality, lang)} ${lang === "ro" ? "din total active" : "of total assets"}`,
        );
        cellsChecked += 1;
      }
      bs.unmount();
      statesChecked += 2;
    }
  });

  it("the fixture: the ratio block withholds its band verdicts too — forwards they are listed, backwards none is", () => {
    const fwd = forward().comparatives.ratios!.band_movements;
    const back = later().comparatives.ratios!.band_movements;
    expect(fwd.verdicts_withheld ?? null).toBeNull();
    expect(fwd.improved.length + fwd.deteriorated.length).toBeGreaterThanOrEqual(5);
    expect(back.verdicts_withheld).toBe("prior_is_later");
    expect(back.improved).toEqual([]);
    expect(back.deteriorated).toEqual([]);
    expect(back.findings).toEqual([]);
    const withheld = back.not_comparable.filter((e) => e.reason_code === "prior_is_later").map((e) => e.key).sort();
    expect(withheld).toEqual([...fwd.improved, ...fwd.deteriorated].sort());
    statesChecked += 1;
  });

  for (const lang of ["ro", "en"] as const) {
    it(`${lang} · Ratios tab: no ratio is listed improved or deteriorated, none is coloured, and the tab says why — once`, async () => {
      const p = later();
      const fwd = forward().comparatives.ratios!.band_movements;
      const crossed = [...fwd.improved, ...fwd.deteriorated];
      renderRatiosTab(p, true);
      await language(lang);
      const section = screen.getByTestId("band-movements");
      expect(section.getAttribute("data-verdicts")).toBe("withheld");
      expect(section.getAttribute("data-withheld")).toBe("prior_is_later");
      expect(screen.getByTestId("band-movements-withheld").textContent).toBe(
        text(lang, "statements.ratioCmp.ui.verdictsWithheldLater"),
      );
      // No list, no count of "improved and deteriorated", and never the
      // false "no ratio crossed a band".
      for (const id of ["band-improved", "band-deteriorated", "band-movements-counts", "band-movements-nothing", "band-movement-item"]) {
        expect(screen.queryByTestId(id), `${id} under a later comparison period`).toBeNull();
      }
      expect(section.textContent).not.toContain(text(lang, "statements.ratioCmp.ui.improvedTitle"));
      expect(section.textContent).not.toContain(text(lang, "statements.ratioCmp.ui.deterioratedTitle"));
      // The table: every row the forward document calls a crossing says the
      // reason in its movement cell, and no change is praised or alarmed.
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="ratio-compare-row"]')];
      expect(rows.length).toBeGreaterThanOrEqual(25);
      let said = 0;
      for (const row of rows) {
        const delta = row.querySelector<HTMLElement>('[data-cell="delta"]');
        const movement = row.querySelector<HTMLElement>('[data-cell="movement"]');
        for (const cell of [delta, movement]) {
          expect(cell?.className ?? "", `${row.dataset.ratioKey}: a verdict's colour`).not.toMatch(/text-(success|alert)/);
        }
        if (crossed.includes(row.dataset.ratioKey!)) {
          expect(movement!.textContent, row.dataset.ratioKey).toBe(text(lang, "statements.ratioCmp.reason.prior_is_later"));
          // The figures are all there: the change is printed.
          expect(delta!.textContent, row.dataset.ratioKey).toMatch(/\d/);
          said += 1;
        }
      }
      expect(said).toBe(crossed.length);
      noRawKeys();
      statesChecked += 1;
    });
  }

  it("forwards the Ratios tab lists them, as served — the withheld state is not the default", () => {
    const p = forward();
    const bm = p.comparatives.ratios!.band_movements;
    renderRatiosTab(p, true);
    const section = screen.getByTestId("band-movements");
    expect(section.getAttribute("data-verdicts")).toBeNull();
    expect(screen.queryByTestId("band-movements-withheld")).toBeNull();
    const keys = (id: string) =>
      [...screen.getByTestId(id).querySelectorAll<HTMLElement>('[data-testid="band-movement-item"]')].map((e) => e.dataset.ratioKey);
    expect(keys("band-improved")).toEqual(bm.improved);
    expect(keys("band-deteriorated")).toEqual(bm.deteriorated);
    statesChecked += 1;
  });

  it("the withheld state is the ENGINE's: an unknown order has its own sentence; where the block does not say, the document's direction does", async () => {
    const p = later();
    p.comparatives.ratios!.band_movements.verdicts_withheld = "period_order_unknown";
    renderRatiosTab(p, true);
    await language("ro");
    expect(screen.getByTestId("band-movements-withheld").textContent).toBe(
      text("ro", "statements.ratioCmp.ui.verdictsWithheldUnknown"),
    );
    cleanup();
    const view = (reason: unknown) => {
      const q = later();
      (q.comparatives.ratios!.band_movements as unknown as { verdicts_withheld: unknown }).verdicts_withheld = reason;
      return printBandMovements(
        buildRatioCompareView({
          periodTable: readRatioTable(q.current_body.assembled_metrics),
          comparativesDoc: q.comparatives,
          currentLabel: "Dec 2024",
        }),
        "en",
      )!;
    };
    expect(view("prior_is_later").verdictsWithheld).toBe("prior_is_later");
    expect(view("period_order_unknown").verdictsWithheld).toBe("period_order_unknown");
    // The block does not say (an older engine), or says a word this build
    // does not know: the DOCUMENT's direction is read — a later comparison
    // period serves no verdict whatever its ratio block carries.
    expect(view(null).verdictsWithheld).toBe("prior_is_later");
    expect(view(undefined).verdictsWithheld).toBe("prior_is_later");
    expect(view("some_reason_of_tomorrow").verdictsWithheld).toBe("prior_is_later");
    expect(view("some_reason_of_tomorrow").improved).toEqual([]);
    // …and a document that says nothing about the order withholds nothing
    // (the order is the engine's to state, never derived here): forwards,
    // and with no `direction` at all.
    const silent = (doc: ComparativesResponse) =>
      printBandMovements(
        buildRatioCompareView({
          periodTable: readRatioTable(forward().current_body.assembled_metrics),
          comparativesDoc: doc,
          currentLabel: "Dec 2025",
        }),
        "en",
      )!;
    const fwd = forward().comparatives;
    expect(silent(fwd).verdictsWithheld).toBeNull();
    const undated = forward().comparatives;
    delete undated.direction;
    expect(silent(undated).verdictsWithheld).toBeNull();
    expect(silent(undated).counts.improved).toBe(fwd.ratios!.band_movements.improved.length);
    statesChecked += 9;
  });

  it("the exports' band lists do not say \"no ratio moved\" over a withheld direction — they say no direction is given", () => {
    // The report and the workbook print the served lists in sentences of
    // their own (lib/executiveSummary.ts). Empty by the engine's hand is not
    // "nothing moved": the crossings are listed as not comparable, with the
    // reason.
    const bands = (p: Pair) =>
      buildBandMovements({ ...p.current_body.statements, comparatives: p.comparatives } as never, null, null);
    const back = bands(later());
    expect(back.available).toBe(true);
    expect(back.improved).toEqual([]);
    expect(back.deteriorated).toEqual([]);
    for (const sentence of [back.improvedAbsence, back.deterioratedAbsence]) {
      expect(sentence).toBe("no ratio is listed: Dec 2025 closes after Dec 2024, so no direction is given to a change");
      expect(sentence).not.toMatch(/no ratio moved/);
    }
    const fwd = forward().comparatives.ratios!.band_movements;
    expect(back.notComparable.filter((n) => /No direction given/.test(n.reason)).length).toBe(
      fwd.improved.length + fwd.deteriorated.length,
    );
    // An order that could not be read has its own words.
    const unknown = later();
    unknown.comparatives.ratios!.band_movements.verdicts_withheld = "period_order_unknown";
    expect(bands(unknown).improvedAbsence).toBe(
      "no ratio is listed: the order of Dec 2025 and Dec 2024 could not be read, so no direction is given to a change",
    );
    // Forwards, an empty list still means what it says.
    const quiet = forward();
    quiet.comparatives.ratios!.band_movements.improved = [];
    expect(bands(quiet).improvedAbsence).toBe("no ratio moved up a band between Dec 2024 and Dec 2025");
    expect(bands(forward()).improvedAbsence).toBeNull();
    statesChecked += 5;
  });

  it("a document that lists verdicts under a later comparison period is not believed", () => {
    storeView({ priorPeriodId: P25 });
    const answers: Answers = () => {
      const doc = later().comparatives;
      doc.movers.improved = forward().comparatives.movers.improved;
      doc.movers.deteriorated = forward().comparatives.movers.deteriorated;
      doc.movers.verdicts_withheld = null;
      return { kind: "ok", data: doc };
    };
    renderWithProviders(mount({ tab: "pl", body: body24(), rows: TWO_YEARS, currentId: P24, answers }));
    expect(screen.queryByTestId("cmp-improved")).toBeNull();
    expect(screen.queryByTestId("cmp-deteriorated")).toBeNull();
    statesChecked += 1;
  });

  for (const order of ["prior_is_later", "unknown"] as const) {
    it(`the Ratios tab does not believe one either (${order}): the document's direction is read, not the ratio block's flag alone`, () => {
      // CONSTRUCTED — the shape the engine served until 2026-10-04 (and what
      // a regression of its ratio block would serve): a direction that
      // serves no verdict over a ratio block that lists sixteen, with no
      // `verdicts_withheld`. The Ratios tab read the block's flag alone and
      // printed "4 improved and 12 deteriorated" and both lists under the
      // page's own "reads backwards" sentence.
      // Built on the served forward pair, so every figure ties to the
      // period on screen: only the document's direction is changed.
      const reason = order === "prior_is_later" ? "prior_is_later" : "period_order_unknown";
      const p = forward();
      p.comparatives.direction = { ...p.comparatives.direction!, order, verdicts_served: false, reason };
      const bm = p.comparatives.ratios!.band_movements;
      expect(bm.verdicts_withheld ?? null).toBeNull();
      const crossed = [...bm.improved, ...bm.deteriorated];
      expect(crossed.length).toBeGreaterThan(5);
      const view = buildRatioCompareView({
        periodTable: readRatioTable(p.current_body.assembled_metrics),
        comparativesDoc: p.comparatives,
        currentLabel: "Dec 2025",
      })!;
      const printed = printBandMovements(view, "en")!;
      expect(printed.verdictsWithheld).toBe(reason);
      expect(printed.improved).toEqual([]);
      expect(printed.deteriorated).toEqual([]);
      // Nothing is counted as improved or deteriorated; the listed crossings
      // are counted where the engine itself puts a withheld one.
      expect([printed.counts.improved, printed.counts.deteriorated]).toEqual([0, 0]);
      expect(printed.counts.notComparable).toBe(bm.not_comparable.length + crossed.length);
      renderRatiosTab(p, true);
      const section = screen.getByTestId("band-movements");
      expect(section.getAttribute("data-verdicts")).toBe("withheld");
      expect(screen.getByTestId("band-movements-withheld").textContent).toBe(
        text("en", order === "prior_is_later" ? "statements.ratioCmp.ui.verdictsWithheldLater" : "statements.ratioCmp.ui.verdictsWithheldUnknown"),
      );
      for (const id of ["band-improved", "band-deteriorated", "band-movements-counts", "band-movements-nothing", "band-movement-item"]) {
        expect(screen.queryAllByTestId(id).length, id).toBe(0);
      }
      // …and no row of the table carries the adjective's colour or the
      // crossing: the change is printed, the movement says why it is not
      // judged.
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="ratio-compare-row"]')];
      expect(rows.length).toBeGreaterThan(20);
      let said = 0;
      for (const row of rows) {
        const delta = row.querySelector<HTMLElement>('[data-cell="delta"]');
        const movement = row.querySelector<HTMLElement>('[data-cell="movement"]');
        for (const cell of [delta, movement]) {
          const classes = cell ? [cell, ...cell.querySelectorAll<HTMLElement>("*")].map((n) => n.className).join(" ") : "";
          expect(classes, `${row.dataset.ratioKey}: a verdict's colour`).not.toMatch(/text-(success|alert)/);
        }
        if (crossed.includes(row.dataset.ratioKey!)) {
          expect(movement!.textContent, row.dataset.ratioKey).toBe(text("en", `statements.ratioCmp.reason.${reason}`));
          expect(delta!.textContent, row.dataset.ratioKey).toMatch(/\d/);
          said += 1;
        }
      }
      expect(said).toBe(crossed.length);
      statesChecked += 1;
    });
  }

  it("an order the engine could not read: its own sentence, no verdict — constructed: no committed pair has the shape", async () => {
    storeView({ priorPeriodId: P25 });
    const answers: Answers = () => {
      const doc = later().comparatives;
      doc.direction = { ...doc.direction!, order: "unknown", reason: "period_order_unknown" };
      return { kind: "ok", data: doc };
    };
    for (const lang of ["en", "ro"] as const) {
      const r = renderWithProviders(mount({ tab: "pl", body: body24(), rows: TWO_YEARS, currentId: P24, answers }));
      await language(lang);
      expect(outcomeNote()!.getAttribute("data-order")).toBe("unknown");
      expect(outcomeNote()!.textContent).toBe(text(lang, "statements.cmp.backwardsUnknown"));
      expect(screen.queryByTestId("cmp-improved")).toBeNull();
      r.unmount();
      statesChecked += 1;
    }
  });

  it("the order is the ENGINE's: a document with no `direction` says nothing, and no date is compared here", () => {
    const doc = later().comparatives;
    delete doc.direction;
    expect(comparisonBackwardsOf(doc)).toBeNull();
    expect(priorIsEarlier(doc)).toBe(true);
    expect(comparisonNoteOf({ kind: "served" }, doc)).toBeNull();
    const same = forward().comparatives;
    same.direction = { ...same.direction!, order: "same_close" };
    expect(comparisonBackwardsOf(same)).toBeNull();
    expect(priorIsEarlier(same)).toBe(false);
    const garbled = forward().comparatives;
    (garbled.direction as unknown as { order: string }).order = "sideways";
    expect(comparisonBackwardsOf(garbled)).toBeNull();
    statesChecked += 3;
  });
});

// ── S6: the request's outcome, on every tab ───────────────────────────

describe("S6 the comparison request's outcome is said on every tab that has the controls", () => {
  const refused: Answers = () => ({ kind: "refused", code: "period_not_servable", message: "period 'x' has no figures" });
  const failed = (status: number): Answers => () => ({ kind: "error", status });

  for (const lang of ["ro", "en"] as const) {
    it(`${lang}: a REFUSAL — the code's sentence, once, on each of the five tabs; the comparison boxes off`, async () => {
      for (const tab of TABS) {
        const b = body25();
        const r = renderWithProviders(mount({ tab, body: b, rows: TWO_YEARS, currentId: P25, answers: refused }));
        await language(lang);
        const note = outcomeNote();
        expect(note, `${tab}: the engine refused, one column on screen, and no word why`).not.toBeNull();
        expect(note!.getAttribute("data-outcome")).toBe("refused");
        expect(note!.id).toBe(COMPARATIVES_OUTCOME_NOTE_ID);
        expect(note!.textContent).toBe(
          `${text(lang, "statements.cmp.refusedTitle")}: ${text(lang, "statements.cmp.refusedNotServable")}`,
        );
        // The engine's message (it can carry a raw period id) is not printed.
        expect(document.body.textContent).not.toContain("period 'x'");
        expect(screen.getAllByTestId("comparatives-refused").length, `${tab}: said twice`).toBe(1);
        expect(noPriorNotice()).toBeNull();
        expect(controls()!.getAttribute("data-comparison")).toBe("refused");
        if (tab === "overview") {
          expect(boxKeys()).toEqual([]);
        } else {
          for (const k of ["prior", "delta", "deltaPct"]) {
            expect(box(k)!.disabled && !box(k)!.checked, `${tab} ${k}`).toBe(true);
            expect(box(k)!.getAttribute("aria-describedby")).toBe(COMPARATIVES_OUTCOME_NOTE_ID);
          }
          const offered = tab === "pl" || tab === "balance_sheet";
          expect(box("share")!.disabled, `${tab} share`).toBe(!offered);
          if (offered) expect(everyShareCellIsServed(b, lang)).toBeGreaterThanOrEqual(tab === "pl" ? 14 : 40);
          const title = (offered ? box("prior")!.closest("label")! : screen.getByTestId("comparatives-columns")).getAttribute("title");
          // A refused comparison will not "load": its own sentence.
          expect(title).toBe(text(lang, "statements.cmp.columnsRefused"));
          expect(title).not.toBe(text(lang, "statements.cmp.columnsFailed"));
        }
        noRawKeys();
        r.unmount();
        statesChecked += 1;
      }
    });

    it(`${lang}: a FAILED request — a sentence and "try again", on each of the five tabs`, async () => {
      for (const tab of TABS) {
        for (const status of [502, 0]) {
          const r = renderWithProviders(mount({ tab, body: body25(), rows: TWO_YEARS, currentId: P25, answers: failed(status) }));
          await language(lang);
          const note = outcomeNote();
          expect(note, `${tab}: the request failed and nothing is said`).not.toBeNull();
          expect(note!.getAttribute("data-outcome")).toBe("failed");
          expect(note!.getAttribute("data-status")).toBe(String(status));
          expect(note!.textContent).toContain(text(lang, "statements.cmp.failedTitle"));
          expect(screen.getByTestId("comparatives-failed-body").textContent).toBe(
            status > 0
              ? text(lang, "statements.cmp.failedBody").replace("{{status}}", String(status))
              : text(lang, "statements.cmp.failedBodyNoResponse"),
          );
          const retry = screen.getByTestId("comparatives-retry");
          expect(retry.textContent).toBe(text(lang, "statements.cmp.failedRetry"));
          expect(retried).not.toHaveBeenCalled();
          fireEvent.click(retry);
          expect(retried).toHaveBeenCalledTimes(1);
          retried.mockClear();
          expect(controls()!.getAttribute("data-comparison")).toBe("failed");
          if (tab !== "overview") {
            for (const k of ["prior", "delta", "deltaPct"]) expect(box(k)!.disabled && !box(k)!.checked).toBe(true);
            const offered = tab === "pl" || tab === "balance_sheet";
            const title = (offered ? box("prior")!.closest("label")! : screen.getByTestId("comparatives-columns")).getAttribute("title");
            expect(title).toBe(text(lang, "statements.cmp.columnsFailed"));
          }
          expect(screen.getAllByTestId("comparatives-outcome").length).toBe(1);
          noRawKeys();
          r.unmount();
          statesChecked += 1;
        }
      }
    });
  }

  it("the outcome is sorted ONCE, where the fetch is: none, pending, refused, failed, served", () => {
    const p = forward();
    const outcome = (priorId: string | null, comparatives: Parameters<typeof ratioSurfacesOf>[0]["comparatives"]) =>
      ratioSurfacesOf({
        assembledMetrics: p.current_body.assembled_metrics,
        statements: p.current_body.statements,
        metricsByName: {},
        currentLabel: "Dec 2025",
        periodId: P25,
        priorId,
        comparatives,
      });
    expect(outcome(null, {}).comparison).toEqual({ kind: "none" });
    expect(outcome(P24, {}).comparison).toEqual({ kind: "pending" });
    expect(outcome(P24, { data: { kind: "refused", code: "same_period", message: "m" } }).comparison).toEqual({
      kind: "refused", code: "same_period",
    });
    expect(outcome(P24, { data: { kind: "error", status: 401 } }).comparison).toEqual({ kind: "failed", status: 401 });
    expect(outcome(P24, { isError: true }).comparison).toEqual({ kind: "failed", status: 0 });
    expect(outcome(P24, { data: { kind: "ok", data: p.comparatives } }).comparison).toEqual({ kind: "served" });
    // …and the exports are built under the same outcome.
    expect(outcome(P24, { data: { kind: "error", status: 502 } }).statementsForExport?.comparison).toEqual({
      kind: "failed", status: 502,
    });
    // The note is a pure reading of it.
    expect(comparisonNoteOf({ kind: "none" }, null)).toBeNull();
    expect(comparisonNoteOf({ kind: "pending" }, null)).toEqual({ kind: "pending" });
    expect(comparisonNoteOf({ kind: "refused", code: "c" }, null)).toEqual({ kind: "refused", code: "c" });
    expect(comparisonNoteOf({ kind: "failed", status: 0 }, null)).toEqual({ kind: "failed", status: 0 });
    expect(comparisonNoteOf({ kind: "served" }, p.comparatives)).toBeNull();
    statesChecked += 12;
  });

  it(`a request in flight is quiet: nothing before ${PENDING_NOTE_DELAY_MS} ms, the loading sentence after, gone when answered`, () => {
    vi.useFakeTimers();
    const r = render(<ComparisonOutcomeNote note={{ kind: "pending" }} />);
    expect(outcomeNote(), "a sentence that would flicker").toBeNull();
    act(() => { vi.advanceTimersByTime(PENDING_NOTE_DELAY_MS - 1); });
    expect(outcomeNote()).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(outcomeNote()!.getAttribute("data-outcome")).toBe("pending");
    expect(outcomeNote()!.textContent).toBe(text("en", "statements.cmp.loading"));
    r.rerender(<ComparisonOutcomeNote note={null} />);
    expect(outcomeNote()).toBeNull();
    // A new request starts the wait again.
    r.rerender(<ComparisonOutcomeNote note={{ kind: "pending" }} />);
    expect(outcomeNote()).toBeNull();
    statesChecked += 4;
  });

  it('"try again" asks the engine once more — and nothing asks on its own', async () => {
    const calls: string[] = [];
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        if (fail) return new Response("bad gateway", { status: 502 });
        return new Response(JSON.stringify(forward().comparatives), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    // The APP's own query defaults — retry and all.
    const client = new QueryClient({ defaultOptions: appQueryClient.getDefaultOptions() });
    function Page() {
      const query = useComparatives(P25, P24, ORG);
      const p = body25();
      const s = ratioSurfacesOf({
        assembledMetrics: p.assembled_metrics,
        statements: p.statements,
        metricsByName: {},
        currentLabel: "Dec 2025",
        periodId: P25,
        priorId: P24,
        comparatives: query,
      });
      return (
        <ComparisonOutcomeNote
          note={comparisonNoteOf(s.comparison, s.cmpDoc)}
          doc={s.cmpDoc}
          onRetry={() => { void query.refetch(); }}
          retrying={query.isFetching}
        />
      );
    }
    render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
    await waitFor(() => expect(outcomeNote()?.getAttribute("data-outcome")).toBe("failed"), { timeout: 10_000 });
    expect(outcomeNote()!.getAttribute("data-status")).toBe("502");
    // No retry loop: past the client's own retry delay, still one request.
    await act(async () => { await new Promise((res) => setTimeout(res, 1300)); });
    expect(calls.length, "the comparison was asked again with nobody asking").toBe(1);

    fail = false;
    fireEvent.click(screen.getByTestId("comparatives-retry"));
    await waitFor(() => expect(outcomeNote()).toBeNull(), { timeout: 10_000 });
    expect(calls.length).toBe(2);
    expect(calls[1]).toBe(calls[0]);
    statesChecked += 2;
  });
});

// ── S7: one way to say "no prior" ─────────────────────────────────────

describe('S7 "no prior" is said one way', () => {
  function ratiosTab(said: boolean) {
    const p = forward();
    const statements = p.current_body.statements;
    const metricsByName: Record<string, number | null> = {};
    for (const m of p.current_body.metrics) metricsByName[m.name] = typeof m.value === "number" ? m.value : null;
    const ratios = computeRatios(
      statements,
      { ebitdaMargin: metricsByName.ebitda_margin ?? null, netMargin: metricsByName.net_margin ?? null },
      metricsByName,
    );
    const env = servedCreditEnvelopes(p.current_body.assembled_metrics, statements, metricsByName);
    const credit = computeCreditScore(statements, env.credit, env.piotroski, env.metricsByName);
    const view = buildRatioCompareView({
      periodTable: readRatioTable(p.current_body.assembled_metrics),
      comparativesDoc: null,
      currentLabel: "Dec 2025",
    })!;
    return renderWithProviders(
      <RatioCompareCtx.Provider value={view}>
        <RatiosTabContent ratios={ratios} statements={statements} altman={altmanRatio(credit)} comparisonSaidByPage={said} />
      </RatioCompareCtx.Provider>,
    );
  }

  it("the Ratios tab says it ONCE on its own, and not at all when the page already does", () => {
    const own = ratiosTab(false);
    expect(screen.getAllByTestId("ratio-prior-state").length).toBe(1);
    expect(within(screen.getByTestId("band-movements")).getByTestId("ratio-prior-state")).not.toBeNull();
    expect(within(screen.getByTestId("ratio-compare-table")).queryByTestId("ratio-prior-state")).toBeNull();
    own.unmount();
    ratiosTab(true);
    expect(screen.queryAllByTestId("ratio-prior-state"), "the page's notice and the tab both say it").toEqual([]);
    statesChecked += 2;
  });

  it("the two components say it only when asked; the table on its own still explains its missing columns", () => {
    const view = buildRatioCompareView({
      periodTable: readRatioTable(body25().assembled_metrics),
      comparativesDoc: null,
      currentLabel: "Dec 2025",
    })!;
    const a = renderWithProviders(<BandMovementLists view={view} stateNote={false} />);
    expect(screen.queryByTestId("ratio-prior-state")).toBeNull();
    expect(screen.getByTestId("band-movements")).not.toBeNull();
    a.unmount();
    const b = renderWithProviders(<RatioComparisonTable view={view} />);
    expect(screen.getAllByTestId("ratio-prior-state").length).toBe(1);
    b.unmount();
    renderWithProviders(<RatioComparisonTable view={view} stateNote={false} />);
    expect(screen.queryByTestId("ratio-prior-state")).toBeNull();
    statesChecked += 3;
  });

  it("what the page says for itself: the no-prior notice, or a refused / failed / pending request", () => {
    expect(comparisonSaidByPage(true, null)).toBe(true);
    expect(comparisonSaidByPage(false, { kind: "refused", code: "c" })).toBe(true);
    expect(comparisonSaidByPage(false, { kind: "failed", status: 0 })).toBe(true);
    expect(comparisonSaidByPage(false, { kind: "pending" })).toBe(true);
    // The reader's own "No comparison", a served document, a backwards one:
    // the page says nothing about a MISSING prior — the tab says it.
    expect(comparisonSaidByPage(false, null)).toBe(false);
    expect(comparisonSaidByPage(false, { kind: "backwards", order: "prior_is_later" })).toBe(false);
    statesChecked += 6;
  });

  function cashFlow(missingPriorLabel: string | null) {
    const s = body24().statements as Body["statements"] & {
      assembled_bs?: Record<string, number>;
      assembled_cf?: Record<string, number>;
    };
    return renderWithProviders(
      <CashFlowStatementView
        hideGuide
        uploadHref={`/workspace?period=${P24}`}
        missingPriorLabel={missingPriorLabel}
        statement={buildCashFlowStatement({
          pl: s.assembled_pl as Record<string, number>,
          bs: s.assembled_bs,
          cf: s.assembled_cf,
          lineItems: [],
          entity: "E",
          period: s.periodLabel ?? "",
          currency: s.currency,
          yearLabel: "2024",
        })}
      />,
    );
  }

  for (const lang of ["ro", "en"] as const) {
    it(`${lang}: the cash-flow card's action names the missing month — in the notice's own words`, async () => {
      const month = lang === "ro" ? "dec. 2023" : "Dec 2023";
      const card = cashFlow(month);
      await language(lang);
      expect(screen.getByTestId("cf-approximation-banner")).not.toBeNull();
      const cta = screen.getByTestId("cf-upload-prior-cta");
      expect(cta.getAttribute("href")).toBe(`/workspace?period=${P24}`);
      // The example of two arbitrary years is gone beside a named month.
      expect(screen.queryByTestId("cf-upload-prior-hint")).toBeNull();
      const words = cta.textContent;
      card.unmount();
      // …the very words the notice's own upload action carries.
      renderWithProviders(mount({ tab: "cash_flow", body: body24(), rows: TWO_YEARS, currentId: P24 }));
      await language(lang);
      expect(words).toBe(screen.getByTestId("comparatives-no-prior-upload").textContent);
      expect(words).toBe(lang === "ro" ? "Încarcă balanța la dec. 2023" : "Upload the Dec 2023 balance");
      statesChecked += 1;
    });
  }

  it("with no month known the card keeps its general action and its example", async () => {
    cashFlow(null);
    await language("ro");
    expect(screen.getByTestId("cf-upload-prior-cta").textContent).toBe(text("ro", "statements.cf.approximated.cta"));
    expect(screen.getByTestId("cf-upload-prior-hint")).not.toBeNull();
    statesChecked += 1;
  });

  it("the month the card names is the one the company has NO balance for — never one that is on file", () => {
    const periods = (rows: Row[]) => companyOf(rows).periods;
    expect(missingPreviousYearEnd(periods(TWO_YEARS), P24, Y24.end)).toBe("2023-12-31");
    expect(missingPreviousYearEnd(periods([Y24]), P24, Y24.end)).toBe("2023-12-31");
    // The year before is on file: nothing is missing.
    expect(missingPreviousYearEnd(periods(TWO_YEARS), P25, Y25.end)).toBeNull();
    // …even at another length.
    const half: Row = { id: "half", start: "2024-07-01", end: "2024-12-31" };
    expect(missingPreviousYearEnd(periods([Y25, half]), P25, Y25.end)).toBeNull();
    // The company's periods are not known yet: "not known" is not "missing".
    expect(missingPreviousYearEnd([], P24, Y24.end)).toBeNull();
    expect(missingPreviousYearEnd(periods([Y24]), P24, null)).toBe("2023-12-31");
    expect(missingPreviousYearEnd(periods([{ ...Y24, end: "" }]), P24, null)).toBeNull();
    statesChecked += 7;
  });

  it("the card speaks to the reader as the rest of the app does (informal register)", () => {
    const body = text("ro", "statements.cf.approximated.body");
    expect(body).toContain("încarcă");
    expect(body).not.toMatch(/încărcați|alegeți|vă rugăm|dumneavoastră/i);
    statesChecked += 1;
  });
});

// ── A payload that outlived the engine ────────────────────────────────

describe("a browser holding a pre-deploy payload asks again", () => {
  it("the persisted cache of the previous version is never hydrated, and is removed", () => {
    vi.useFakeTimers();
    const uid = "5e55-u1";
    window.localStorage.setItem("sb-test-auth-token", JSON.stringify({ user: { id: uid } }));
    const stale = new QueryClient();
    stale.setQueryData(["period", "p-old"], { kind: "ok", data: { statements: {} } });
    const blob = (key: string) =>
      window.localStorage.setItem(
        key,
        JSON.stringify({ at: Date.now(), uid, state: { mutations: [], queries: stale.getQueryCache().getAll().map((q) => ({ queryKey: q.queryKey, queryHash: q.queryHash, state: q.state })) } }),
      );
    blob("cfoai-query-cache-v1");
    setupQueryPersistence();
    expect(window.localStorage.getItem("cfoai-query-cache-v1"), "the retired blob still sits in the quota").toBeNull();
    expect(appQueryClient.getQueryData(["period", "p-old"]), "a pre-deploy payload was hydrated").toBeUndefined();
    // The current version IS hydrated — the premise of the bump.
    blob("cfoai-query-cache-v2");
    setupQueryPersistence();
    expect(appQueryClient.getQueryData(["period", "p-old"])).toBeDefined();
    appQueryClient.clear();
    statesChecked += 3;
  });

  it("a failed answer is never written to disk: the next boot asks, it does not replay the failure", () => {
    vi.useFakeTimers();
    window.localStorage.setItem("sb-test-auth-token", JSON.stringify({ user: { id: "5e55-u1" } }));
    setupQueryPersistence();
    appQueryClient.setQueryData(["comparatives", ORG, P25, P24], { kind: "error", status: 502 });
    appQueryClient.setQueryData(["comparatives", ORG, P25, "refused"], { kind: "refused", code: "same_period", message: "m" });
    appQueryClient.setQueryData(["period", P25], { kind: "ok", data: {} });
    window.dispatchEvent(new Event("pagehide"));
    const blob = JSON.parse(window.localStorage.getItem("cfoai-query-cache-v2") ?? "{}") as {
      state?: { queries?: { queryKey: unknown[]; state: { data: { kind: string } } }[] };
    };
    const kinds = (blob.state?.queries ?? []).map((q) => q.state.data.kind).sort();
    expect(kinds, "a failure was persisted").toEqual(["ok", "refused"]);
    appQueryClient.clear();
    statesChecked += 1;
  });

  it("a comparison document with no `direction` predates the engine answering now — and only such a one", () => {
    const doc = forward().comparatives;
    expect(documentPredatesDirection(doc)).toBe(false);
    expect(documentPredatesDirection(later().comparatives)).toBe(false);
    const old = forward().comparatives;
    delete old.direction;
    expect(documentPredatesDirection(old)).toBe(true);
    old.direction = null;
    expect(documentPredatesDirection(old)).toBe(true);
    // No document is not an old document: nothing to ask again.
    expect(documentPredatesDirection(null)).toBe(false);
    expect(documentPredatesDirection(undefined)).toBe(false);
    statesChecked += 6;
  });

  it("an answer off the disk is told apart from one this session fetched", () => {
    const client = new QueryClient();
    hydrate(client, {
      mutations: [],
      queries: [
        {
          queryKey: ["period", "from-disk"],
          queryHash: JSON.stringify(["period", "from-disk"]),
          state: { data: { kind: "ok" }, dataUpdatedAt: QUERY_SESSION_STARTED_AT - 60_000, status: "success" } as never,
        },
      ],
    });
    client.setQueryData(["period", "fetched-now"], { kind: "ok" });
    expect(answeredBeforeThisSession(client, ["period", "from-disk"])).toBe(true);
    expect(answeredBeforeThisSession(client, ["period", "fetched-now"])).toBe(false);
    expect(answeredBeforeThisSession(client, ["period", "never-asked"])).toBe(false);
    statesChecked += 3;
  });
});

// ── The source: no browser arithmetic on the share path ───────────────

const REPO = process.cwd();
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

const ARITHMETIC = new Set([
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
]);
const ROUNDING_METHODS = new Set(["toFixed", "toPrecision", "toExponential"]);
/** The ONLY things `Math` may be asked on the share path: none of them
 *  divides, scales or rounds. Every other use of `Math` is a site — a
 *  rounding (`round`, `floor`, …), and a division written without a `/`
 *  (`Math.exp(Math.log(a) - Math.log(b))`, `Math.pow(b, -1)`), which the
 *  second review planted and the operator scan alone did not see. */
const MATH_SAFE = new Set(["abs", "max", "min", "sign"]);

interface Site { text: string; context: string }

/** Every division, multiplication, remainder or power, every rounding call
 *  and every use of `Math` beyond `MATH_SAFE`, in a source — read off the
 *  syntax tree, so a `/` in a comment, a string, a class name or a closing
 *  tag is not one. `context` is the nearest enclosing declaration,
 *  attribute or braced expression. */
function arithmeticSites(source: string, name = "x.tsx"): Site[] {
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const flat = (n: ts.Node) => n.getText(sf).replace(/\s+/g, " ");
  const contextOf = (n: ts.Node): string => {
    for (let p: ts.Node | undefined = n; p; p = p.parent) {
      if (ts.isVariableDeclaration(p) || ts.isJsxAttribute(p) || ts.isJsxExpression(p) || ts.isPropertyAssignment(p)) {
        return flat(p);
      }
    }
    return flat(n);
  };
  const out: Site[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && ARITHMETIC.has(n.operatorToken.kind)) {
      out.push({ text: flat(n), context: contextOf(n) });
    } else if (
      ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ROUNDING_METHODS.has(n.expression.name.text)
    ) {
      out.push({ text: flat(n), context: contextOf(n) });
    } else if (ts.isIdentifier(n) && n.text === "Math") {
      // `Math.abs(x)` and its three siblings pass; `Math.round(x)`,
      // `Math.exp(…)`, `Math["log"]`, `const { pow } = Math` do not.
      const access = n.parent;
      const safe = ts.isPropertyAccessExpression(access) && access.expression === n && MATH_SAFE.has(access.name.text);
      if (!safe) {
        const site = ts.isPropertyAccessExpression(access) && ts.isCallExpression(access.parent) ? access.parent : access;
        out.push({ text: flat(site), context: contextOf(site) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The share path: where a served amount or a served share is in hand. */
const NO_ARITHMETIC = [
  "frontend/lib/commonSize.ts",
  "frontend/lib/comparisonState.ts",
  "frontend/lib/comparisonSurface.ts",
  "frontend/lib/periodReset.ts",
  "frontend/lib/useRatioSurfaces.ts",
  "frontend/lib/bsStructure.ts",
  "frontend/lib/buildBsStatement.ts",
  "frontend/components/cfo/ComparativeCells.tsx",
  "frontend/components/cfo/ComparativesPanel.tsx",
  "frontend/components/cfo/ComparisonSurface.tsx",
  "frontend/components/cfo/PLStatementView.tsx",
  "frontend/components/cfo/CashFlowStatementView.tsx",
  "frontend/components/cfo/ratios/RatiosTab.tsx",
  "frontend/components/cfo/ratios/BandMovementLists.tsx",
  "frontend/components/cfo/ratios/RatioComparisonTable.tsx",
];

/** The other files this lane touched: every site they held before it, by
 *  its text — and no other. A site that goes away is taken off the list. */
const PINNED: Record<string, string[]> = {
  // The three printers of a served fraction (`formatDeltaPct`,
  // `formatShare`, `formatPts`) and one duration.
  "frontend/lib/comparatives.ts": [
    "5 * 60_000",
    "v * 100",
    "pct.toFixed(1)",
    "(v * 100).toFixed(1)",
    "v * 100",
    "v.toFixed(1)",
  ],
  // The canonical status strip's "% of assets" readout (the one display
  // computation its contract sanctions) and the AI lane's confidence.
  "frontend/components/cfo/BSStatementView.tsx": [
    "(Math.abs(m.difference as number) / Math.abs(m.totalAssets as number)) * 100",
    "Math.abs(m.difference as number) / Math.abs(m.totalAssets as number)",
    "pct.toFixed(2)",
    "c * 100",
    "Math.round(confidencePct(e.confidence))",
  ],
  // A duration, written as a product.
  "frontend/lib/queryPersist.ts": ["24 * 60 * 60 * 1000", "24 * 60 * 60", "24 * 60"],
};

/**
 * THE MODULES A SHARE-PATH FILE MAY IMPORT A VALUE FROM, beside the scanned
 * ones (`NO_ARITHMETIC`, `PINNED`): what they imported before this law, by
 * module. Arithmetic moved OUT of a scanned file into a helper it imports
 * would otherwise pass the scan (review 2026-10-04: a balance-sheet share
 * divided behind a helper in a new file left the gate green) — a NEW module
 * here is a module somebody must look at. A type-only import carries no code
 * and a stylesheet no arithmetic; neither is listed.
 */
const TRUSTED_MODULES = [
  "frontend/components/cfo/AccountChip",
  "frontend/components/cfo/RatioDetailDrawer",
  "frontend/components/cfo/benchmark/SectorBenchmarkSection",
  "frontend/components/cfo/ratioAbsenceI18n",
  "frontend/components/cfo/ratios/InventoryDaysSplit",
  "frontend/components/cfo/simple/ShowAllLines",
  "frontend/components/cfo/simple/SimpleTermLabel",
  "frontend/components/cfo/simple/termForRow",
  "frontend/components/cfo/useHighlightFromUrl",
  "frontend/components/instrument/Term",
  "frontend/components/learning/GuideMeButton",
  "frontend/components/learning/LearnableNumber",
  "frontend/components/learning/pageGuides",
  "frontend/lib/activePeriod",
  "frontend/lib/cfStructure",
  "frontend/lib/changeKind",
  "frontend/lib/comparisonRefusal",
  "frontend/lib/financialReport",
  "frontend/lib/formatRon",
  "frontend/lib/learning/bucketToConcept",
  "frontend/lib/locale",
  "frontend/lib/money",
  "frontend/lib/orgPeriods",
  "frontend/lib/plStructure",
  "frontend/lib/ratioCompareView",
  "frontend/lib/ratioTable",
  "frontend/lib/sectorBenchmark",
  "frontend/lib/servedFacts",
  "frontend/lib/servedOneEbitda",
  "frontend/lib/traceableSource",
  "frontend/lib/viewMode",
  "frontend/stores/comparativesView",
  "frontend/stores/currency",
];

const localModule = (rel: string, spec: string): string | null =>
  spec.endsWith(".css")
    ? null
    : spec.startsWith("@/") ? `frontend/${spec.slice(2)}` : spec.startsWith(".") ? join(dirname(rel), spec) : null;

/** Every local module a source imports a VALUE from, as a repo path without
 *  its extension ("@/lib/x" and "./x" resolved; packages, type-only imports
 *  and stylesheets left out). */
function valueImportsOf(rel: string, source = read(rel)): string[] {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  sf.forEachChild((n) => {
    if (!ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier)) return;
    const local = localModule(rel, n.moduleSpecifier.text);
    if (local === null) return;
    const clause = n.importClause;
    const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null;
    const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!named && named.every((e) => e.isTypeOnly)));
    if (!typeOnly) out.push(local);
  });
  return out;
}

/**
 * THE PACKAGES A SHARE-PATH FILE MAY IMPORT A VALUE FROM: the four it
 * imported when the law was written — React, the router, i18n and the
 * icons (the query client is imported for its types only). A division
 * needs no local helper either
 * (`import divide from "lodash/divide"`): a package is code nobody here
 * scans, so a NEW one on the share path is a thing to look at.
 */
const TRUSTED_PACKAGES = ["lucide-react", "react", "react-i18next", "react-router-dom"];

/** Every PACKAGE a source imports or re-exports a value from (the specifier
 *  as written; type-only imports and stylesheets left out). */
function packageImportsOf(rel: string, source = read(rel)): string[] {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  sf.forEachChild((n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      if (spec.endsWith(".css") || spec.startsWith("@/") || spec.startsWith(".")) return;
      const clause = n.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null;
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!named && named.every((e) => e.isTypeOnly)));
      if (!typeOnly) out.push(spec);
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      if (!spec.startsWith("@/") && !spec.startsWith(".") && !n.isTypeOnly) out.push(spec);
    }
  });
  return out;
}

/** Every local module a source RE-EXPORTS a value from (`export { x } from`,
 *  `export * from`): a module reached through another one's name. A
 *  type-only re-export carries no code. */
function valueReexportsOf(rel: string, source = read(rel)): string[] {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  sf.forEachChild((n) => {
    if (!ts.isExportDeclaration(n) || !n.moduleSpecifier || !ts.isStringLiteral(n.moduleSpecifier)) return;
    const local = localModule(rel, n.moduleSpecifier.text);
    if (local === null) return;
    const named = n.exportClause && ts.isNamedExports(n.exportClause) ? n.exportClause.elements : null;
    const typeOnly = n.isTypeOnly || (!!named && named.every((e) => e.isTypeOnly));
    if (!typeOnly) out.push(local);
  });
  return out;
}

/** Every way a source loads code WITHOUT an import declaration: `import(…)`,
 *  `require(…)`, and anything asked of `import.meta` but its `env`
 *  (`import.meta.glob`, a URL to load). None has a module the import law
 *  can read. */
function undeclaredLoadsOf(rel: string, source = read(rel)): string[] {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const flat = (n: ts.Node) => n.getText(sf).replace(/\s+/g, " ");
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) out.push(flat(n));
    else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require") out.push(flat(n));
    else if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword) {
      const reads = ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n ? n.parent.name.text : null;
      if (reads !== "env") out.push(flat(n.parent));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The file of a module named without its extension. */
function moduleFile(mod: string): string {
  const found = [".ts", ".tsx", "/index.ts", "/index.tsx"].map((ext) => mod + ext).find((f) => existsSync(resolve(REPO, f)));
  if (!found) throw new Error(`no file for module ${mod}`);
  return found;
}

/**
 * THE ARITHMETIC OF EVERY TRUSTED MODULE, by its text, as it stood when the
 * module was trusted (`fixtures/sharePathTrustedArithmetic.json`). A module
 * on `TRUSTED_MODULES` is not scanned for being arithmetic-free — `lib/money`
 * and `lib/financialReport` divide for a living — so a division ADDED to one
 * and called from a share cell passed every law (second review, 2026-10-04:
 * `ratioOf` planted in `lib/changeKind`, called from `ComparativeCells`). Now
 * a site added to, changed in or removed from a trusted module is a
 * difference somebody must look at. After looking — and only then — rewrite
 * the pin:
 *   SHARE_PATH_PIN=write npx vitest run frontend/components/cfo/__tests__/singleYearShare.test.tsx -t "trusted module"
 */
const TRUSTED_PIN = "frontend/components/cfo/__tests__/fixtures/sharePathTrustedArithmetic.json";

describe("the source — no share is divided, multiplied or rounded in the browser", () => {
  it("the detector sees what it must, and nothing in a comment, a string or a tag", () => {
    const seen = (src: string) => arithmeticSites(src).map((s) => s.text);
    expect(seen("const a = closing / Math.abs(base);")).toEqual(["closing / Math.abs(base)"]);
    expect(seen("const p = (cur - pri) * 100;")).toEqual(["(cur - pri) * 100"]);
    expect(seen("const s = share.toFixed(1);")).toEqual(["share.toFixed(1)"]);
    expect(seen("const r = Math.round(x);")).toEqual(["Math.round(x)"]);
    expect(seen("let t = 1; t /= 3; t *= 2; const m = t % 2; const q = t ** 2;").length).toBe(4);
    expect(seen("const x = <span title={`${a / b}`}>{c}</span>;")).toEqual(["a / b"]);
    // A division needs no `/`: every use of `Math` beyond abs / max / min /
    // sign is a site, and so is an exponent's rounding.
    expect(seen("const s = Math.exp(Math.log(part) - Math.log(total));")).toEqual([
      "Math.exp(Math.log(part) - Math.log(total))", "Math.log(part)", "Math.log(total)",
    ]);
    expect(seen("const s = part * Math.pow(total, -1);").length).toBe(2);
    expect(seen('const f = Math["exp"]; const { log } = Math; const m = Math;').length).toBe(3);
    expect(seen("const s = x.toExponential(2);")).toEqual(["x.toExponential(2)"]);
    expect(seen("const a = Math.abs(x) + Math.max(y, 0) - Math.min(z, 1) + Math.sign(w);")).toEqual([]);
    expect(
      seen('// a / b * c\n/* x.toFixed(1) */\nconst s = "1 / 2 * 3"; const c = <br/>; const d = <i className="w-1/2">a / b</i>; const re = /a*b/;'),
    ).toEqual([]);
    statesChecked += 12;
  });

  it("the share path holds no arithmetic at all", () => {
    for (const rel of NO_ARITHMETIC) {
      expect(arithmeticSites(read(rel), rel).map((s) => s.text), rel).toEqual([]);
      statesChecked += 1;
    }
  });

  it("a share-path file imports values only from scanned modules and the ones it imported before — no new helper to hide a division in", () => {
    const stem = (rel: string) => rel.replace(/\.tsx?$/, "");
    const scanned = new Set([...NO_ARITHMETIC, ...Object.keys(PINNED)].map(stem));
    const allowed = new Set([...scanned, ...TRUSTED_MODULES]);
    const used = new Set<string>();
    for (const rel of NO_ARITHMETIC) {
      const imports = valueImportsOf(rel);
      for (const mod of imports) used.add(mod);
      expect(imports.filter((mod) => !allowed.has(mod)), `${rel} imports a module nobody scans`).toEqual([]);
      statesChecked += 1;
    }
    // The list only shrinks: a module nothing on the share path imports any
    // more is taken off it.
    expect(TRUSTED_MODULES.filter((mod) => !used.has(mod))).toEqual([]);
    expect(TRUSTED_MODULES.filter((mod) => scanned.has(mod)), "a scanned module needs no trust").toEqual([]);
    // The reader sees what it must.
    const src = [
      'import type { A } from "@/lib/onlyTypes";',
      'import { type B, type C } from "@/lib/alsoOnlyTypes";',
      'import { d, type E } from "@/lib/shareHelper";',
      'import f from "./sibling";',
      'import "./sheet.css";',
      'import { useMemo } from "react";',
    ].join("\n");
    expect(valueImportsOf("frontend/components/cfo/X.tsx", src)).toEqual([
      "frontend/lib/shareHelper", "frontend/components/cfo/sibling",
    ]);
    statesChecked += 3;
  });

  it("a share-path file imports values only from the packages it imported before — no arithmetic library", () => {
    const used = new Set<string>();
    for (const rel of NO_ARITHMETIC) {
      const packages = packageImportsOf(rel);
      for (const pkg of packages) used.add(pkg);
      expect(packages.filter((pkg) => !TRUSTED_PACKAGES.includes(pkg)), `${rel} imports a package nobody scans`).toEqual([]);
      statesChecked += 1;
    }
    // The list only shrinks.
    expect(TRUSTED_PACKAGES.filter((pkg) => !used.has(pkg))).toEqual([]);
    // The reader sees what it must.
    const src = [
      'import divide from "lodash/divide";',
      'import { create, all } from "mathjs";',
      'import type { Big } from "big.js";',
      'import { useMemo, type ReactNode } from "react";',
      'import { local } from "@/lib/local";',
      'import "./sheet.css";',
      'export { round } from "lodash";',
    ].join("\n");
    expect(packageImportsOf("frontend/components/cfo/X.tsx", src)).toEqual(["lodash/divide", "mathjs", "react", "lodash"]);
    statesChecked += 2;
  });

  it("no module is reached without an import declaration: no re-export to an unscanned module, no dynamic import, on the share path or in a trusted module", () => {
    const stem = (rel: string) => rel.replace(/\.tsx?$/, "");
    const scanned = [...NO_ARITHMETIC, ...Object.keys(PINNED)];
    const allowed = new Set([...scanned.map(stem), ...TRUSTED_MODULES]);
    // A share-path file loads nothing the import law cannot read…
    for (const rel of NO_ARITHMETIC) {
      expect(undeclaredLoadsOf(rel), `${rel} loads code without an import declaration`).toEqual([]);
      statesChecked += 1;
    }
    // …and neither a scanned nor a trusted module hands on, under its own
    // name, a value from a module nobody scans (`export { x } from "./new"`).
    for (const rel of [...scanned, ...TRUSTED_MODULES.map(moduleFile)]) {
      expect(valueReexportsOf(rel).filter((mod) => !allowed.has(mod)), `${rel} re-exports a module nobody scans`).toEqual([]);
      statesChecked += 1;
    }
    for (const mod of TRUSTED_MODULES) {
      expect(undeclaredLoadsOf(moduleFile(mod)), `${mod} loads code without an import declaration`).toEqual([]);
    }
    // The readers see what they must.
    const src = [
      'export { a } from "@/lib/newHelper";',
      'export * from "./other";',
      'export type { T } from "@/lib/onlyTypes";',
      'export { type U } from "@/lib/alsoOnlyTypes";',
      "export const local = 1;",
    ].join("\n");
    expect(valueReexportsOf("frontend/lib/x.ts", src)).toEqual(["frontend/lib/newHelper", "frontend/lib/other"]);
    expect(
      undeclaredLoadsOf(
        "frontend/lib/x.ts",
        'const { d } = await import("@/lib/h"); const r = require("./h"); const g = import.meta.glob("./*.ts"); ' +
          'const mode = import.meta.env.MODE; import s from "./static";',
      ),
    ).toEqual(['import("@/lib/h")', 'require("./h")', "import.meta.glob"]);
    statesChecked += 2;
  });

  it("a trusted module holds the arithmetic it held when it was trusted, and no other", () => {
    const now: Record<string, string[]> = {};
    for (const mod of TRUSTED_MODULES) now[mod] = arithmeticSites(read(moduleFile(mod)), moduleFile(mod)).map((s) => s.text);
    if (process.env.SHARE_PATH_PIN === "write") {
      writeFileSync(
        resolve(REPO, TRUSTED_PIN),
        JSON.stringify(
          {
            _what: "Every arithmetic site (the gate's detector) of every module on TRUSTED_MODULES of singleYearShare.test.tsx, by its text.",
            _rewrite: 'After LOOKING at the difference: SHARE_PATH_PIN=write npx vitest run frontend/components/cfo/__tests__/singleYearShare.test.tsx -t "trusted module"',
            modules: now,
          },
          null,
          1,
        ) + "\n",
      );
    }
    const pinned = (JSON.parse(read(TRUSTED_PIN)) as { modules: Record<string, string[]> }).modules;
    expect(Object.keys(pinned).sort(), "the pin names exactly the trusted modules").toEqual([...TRUSTED_MODULES].sort());
    let sites = 0;
    for (const mod of TRUSTED_MODULES) {
      expect(now[mod], `${mod}: its arithmetic changed — look at the difference, then rewrite the pin`).toEqual(pinned[mod]);
      sites += now[mod].length;
      statesChecked += 1;
    }
    // The detector is not blind to them: the trusted modules DO divide.
    expect(sites).toBeGreaterThan(50);
    expect(process.env.SHARE_PATH_PIN, "the pin was rewritten by this run — run again without SHARE_PATH_PIN").toBeUndefined();
  });

  it("the other touched files hold the sites they held before this lane, and no new one", () => {
    for (const [rel, pinned] of Object.entries(PINNED)) {
      expect(arithmeticSites(read(rel), rel).map((s) => s.text), rel).toEqual(pinned);
      statesChecked += 1;
    }
  });

  it("the dashboard page computes nothing where it wires the comparison or the share", () => {
    const page = read("frontend/pages/cfo/FinancialStatements.tsx");
    const sites = arithmeticSites(page, "FinancialStatements.tsx");
    // The page does hold arithmetic of its own (the detector is not blind)…
    expect(sites.length).toBeGreaterThan(10);
    // …none of it in a declaration, an attribute or an expression that
    // names the comparison, the share block or anything built from them.
    const WIRING = /\b(cmp[A-Z]\w*|commonSize|common_size|comparison\w*|ComparativeProvider|shareOfferOf|readCommonSize|current_share|prior_share|delta_pts)\b/;
    const near = sites.filter((s) => WIRING.test(s.context));
    expect(near.map((s) => s.context)).toEqual([]);
    statesChecked += 1;
  });
});

// ── The page renders the one composition ──────────────────────────────

describe("the dashboard — it renders the ONE composition, and nothing of the comparison beside it", () => {
  const PAGE = "frontend/pages/cfo/FinancialStatements.tsx";
  const raw = read(PAGE);
  const sf = ts.createSourceFile(PAGE, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  /** A node's own text, whitespace folded — its WHOLE text, so a changed
   *  operand, an added `&& false` or a dropped prop is a different string. */
  const flat = (n: ts.Node) => n.getText(sf).replace(/\s+/g, " ").trim();
  const walk = (visit: (n: ts.Node) => void) => {
    const go = (n: ts.Node) => { visit(n); ts.forEachChild(n, go); };
    go(sf);
  };
  /** Every JSX element of the page with this tag: the self-closing element,
   *  or the opening one. */
  const elements = (name: string): (ts.JsxSelfClosingElement | ts.JsxOpeningElement)[] => {
    const out: (ts.JsxSelfClosingElement | ts.JsxOpeningElement)[] = [];
    walk((n) => {
      if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(sf) === name) out.push(n);
    });
    return out;
  };
  /** Every use of a name in the page's code — an import, a call, a
   *  reference. (A JSX attribute of that name on another component is a
   *  prop, not a use of the function.) */
  const identifiers = (name: string): ts.Identifier[] => {
    const out: ts.Identifier[] = [];
    walk((n) => { if (ts.isIdentifier(n) && n.text === name && !ts.isJsxAttribute(n.parent)) out.push(n); });
    return out;
  };
  const declaration = (name: string): ts.VariableDeclaration => {
    const found: ts.VariableDeclaration[] = [];
    walk((n) => { if (ts.isVariableDeclaration(n) && n.name.getText(sf) === name) found.push(n); });
    expect(found.length, `one declaration of ${name}`).toBe(1);
    return found[0];
  };

  it("no comparison markup of its own, and no second reading of what the composition reads", () => {
    // The pieces the shared components render: the page renders none itself.
    for (const name of [
      "ComparativesControls", "ComparativesNoPriorNote", "ComparisonOutcomeNote", "ComparativesRefusedNote", "ComparativeProvider",
    ]) {
      expect(elements(name).length, `<${name}> in the page`).toBe(0);
      expect(identifiers(name).length, `${name} named in the page`).toBe(0);
    }
    // The readings the composition makes: the page makes none of them again.
    for (const fn of [
      "readCommonSize", "shareOfferOf", "comparisonNoteOf", "comparisonSaidByPage", "noPriorStateOf",
      "missingPreviousYearEnd", "columnBoxesOf", "comparisonBlockOf", "statementComparisonOf", "comparisonBackwardsOf",
    ]) {
      expect(identifiers(fn).length, `${fn} called in the page`).toBe(0);
    }
    statesChecked += 2;
  });

  it("the composition is called ONCE, with exactly these inputs", () => {
    // (the import and the call)
    expect(identifiers("comparisonSurfaceOf").length).toBe(2);
    expect(flat(declaration("cmpSurface"))).toBe(
      "cmpSurface = useMemo( () => comparisonSurfaceOf({ tab: activeTab, statements, " +
        "rendersCanonicalBs: (remotePeriod.lineItems?.length ?? 0) > 0 && !!statements?.canonical_bs, " +
        "periods: cmpPeriods, currentId: remotePeriod.id, currentEnd: remotePeriod.periodEnd, " +
        "autoPick: cmpAutoPick, priorId: cmpPriorId, stored: cmpView.view.priorPeriodId, " +
        "columns: cmpView.view.columns, doc: cmpDoc, outcome: cmpOutcome, }), " +
        "[activeTab, statements, remotePeriod.lineItems, remotePeriod.id, remotePeriod.periodEnd, cmpPeriods, " +
        "cmpAutoPick, cmpPriorId, cmpView.view.priorPeriodId, cmpView.view.columns, cmpDoc, cmpOutcome], )",
    );
    // What feeds it is the one choice and the one sorted fetch.
    expect(flat(declaration("cmpPeriods"))).toBe("cmpPeriods = cmpChoice.periods");
    expect(flat(declaration("cmpAutoPick"))).toBe("cmpAutoPick = cmpChoice.autoPick");
    expect(flat(declaration("cmpPriorId"))).toBe("cmpPriorId: string | null = cmpChoice.priorId");
    expect(flat(declaration("cmpQuery"))).toBe("cmpQuery = useComparatives(remotePeriod.id, cmpPriorId, cmpCompanyId)");
    expect(raw).toMatch(/const \{ cmpDoc, cmpRefused, comparison: cmpOutcome, [^}]*\} = useRatioSurfaces\(\{/);
    statesChecked += 6;
  });

  it("the controls: ONE element, the sticky bar's own child — under no condition the page could get wrong", () => {
    const els = elements("ComparisonControlsBar");
    expect(els.length).toBe(1);
    expect(flat(els[0])).toBe("<ComparisonControlsBar surface={cmpSurface} />");
    const parent = els[0].parent;
    expect(ts.isJsxElement(parent), "the controls sit inside an expression, not directly in the bar").toBe(true);
    expect(flat((parent as ts.JsxElement).openingElement)).toMatch(/^<div className=\{`sticky /);
    statesChecked += 1;
  });

  it("the notes: ONE element, below the sticky bar — under no condition the page could get wrong", () => {
    const els = elements("ComparisonNotes");
    expect(els.length).toBe(1);
    expect(flat(els[0])).toBe(
      "<ComparisonNotes surface={cmpSurface} " +
        'uploadHref={remotePeriod.id ? `/workspace?period=${encodeURIComponent(remotePeriod.id)}` : "/workspace"} ' +
        "onRetry={() => { void cmpQuery.refetch(); }} retrying={cmpQuery.isFetching} />",
    );
    expect(ts.isJsxElement(els[0].parent), "the notes sit inside an expression (`cond && …`)").toBe(true);
    expect(els[0].getStart(sf)).toBeGreaterThan(elements("ComparisonControlsBar")[0].getStart(sf));
    statesChecked += 1;
  });

  it("each statement tab's provider is the shared one, handed the surface and ITS tab, around ITS view", () => {
    const opens = elements("StatementComparison");
    expect(opens.map(flat)).toEqual([
      '<StatementComparison surface={cmpSurface} statement="pl">',
      '<StatementComparison surface={cmpSurface} statement="balance_sheet">',
      '<StatementComparison surface={cmpSurface} statement="cash_flow">',
    ]);
    const VIEW = ["PLStatementView", "BSStatementView", "CashFlowStatementView"];
    opens.forEach((open, i) => {
      const inside = (open.parent as ts.JsxElement).children.filter(ts.isJsxSelfClosingElement).map((c) => c.tagName.getText(sf));
      expect(inside, flat(open)).toEqual([VIEW[i]]);
    });
    statesChecked += 1;
  });

  it("the Ratios tab and the cash-flow card are told what the page already says", () => {
    const ratios = elements("RatiosTabContent");
    expect(ratios.length).toBe(1);
    expect(flat(ratios[0])).toContain("comparisonSaidByPage={cmpSurface.saidByPage}");
    const tab = read("frontend/components/cfo/ratios/RatiosTab.tsx");
    expect(tab).toMatch(/<BandMovementLists view=\{view\} stateNote=\{!comparisonSaidByPage\} \/>/);
    expect(tab).toMatch(/<RatioComparisonTable view=\{view\} highlightKey=\{evidenceKey\} stateNote=\{false\} \/>/);
    expect(flat(elements("CashFlowStatementView")[0])).toContain("missingPriorLabel={cmpMissingPriorLabel}");
    expect(flat(declaration("cmpMissingPriorLabel"))).toBe(
      "cmpMissingPriorLabel = useMemo( () => formatPeriodMonth(cmpSurface.missingPriorEnd, cmpLocale), [cmpSurface.missingPriorEnd, cmpLocale], )",
    );
    statesChecked += 1;
  });

  it("an answer off the disk that lacks what the engine now serves is asked once more: the period's block, the comparison's direction", () => {
    const code = raw.replace(/\s+/g, " ");
    expect(code).toContain(
      'useEffect(() => { if (!remotePeriod.id || remotePeriod.source !== "upload" || !statements || cmpSurface.commonSize) return; ' +
        "const key = periodQueryKey(remotePeriod.id); if (!answeredBeforeThisSession(queryClient, key)) return; " +
        "void queryClient.invalidateQueries({ queryKey: key }); }, " +
        "[remotePeriod.id, remotePeriod.source, statements, cmpSurface.commonSize, queryClient]);",
    );
    expect(code).toContain(
      "useEffect(() => { if (!cmpCompanyId || !remotePeriod.id || !cmpPriorId || !documentPredatesDirection(cmpDoc)) return; " +
        "const key = comparativesQueryKey(cmpCompanyId, remotePeriod.id, cmpPriorId); " +
        "if (!answeredBeforeThisSession(queryClient, key)) return; void queryClient.invalidateQueries({ queryKey: key }); }, " +
        "[cmpCompanyId, remotePeriod.id, cmpPriorId, cmpDoc, queryClient]);",
    );
    const persist = read("frontend/lib/queryPersist.ts");
    expect(persist).toMatch(/const STORAGE_KEY = "cfoai-query-cache-v2";/);
    expect(persist).toMatch(/const RETIRED_STORAGE_KEYS = \["cfoai-query-cache-v1"\];/);
    statesChecked += 1;
  });

  it("every path that resets a period resets its comparisons: the one helper, and no bare reset anywhere", () => {
    const sources: string[] = [];
    const collect = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "__tests__" || name === "test") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) collect(full);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) sources.push(relative(REPO, full));
      }
    };
    collect(resolve(REPO, "frontend"));
    expect(sources.length).toBeGreaterThan(400);
    const BARE = /resetQueries\(\s*\{\s*queryKey:\s*periodQueryKey\(/;
    const bare: string[] = [];
    const calls: Record<string, number> = {};
    for (const rel of sources) {
      const src = read(rel);
      if (BARE.test(src) && rel !== "frontend/lib/periodReset.ts") bare.push(rel);
      const n = src.match(/\bresetPeriodAnswers\(/g)?.length ?? 0;
      if (n && rel !== "frontend/lib/periodReset.ts") calls[rel] = n;
    }
    expect(bare, "a period reset that leaves its comparisons in the cache").toEqual([]);
    // The helper itself holds the one bare reset.
    expect(BARE.test(read("frontend/lib/periodReset.ts"))).toBe(true);
    expect(calls).toEqual({
      "frontend/components/cfo/BSStatementView.tsx": 2,
      // The workspace upload card: a finished job resets the period its file
      // landed on (it was the one upload path that reset neither the period
      // nor its comparisons).
      "frontend/components/cfo/upload/UploadFlowHost.tsx": 1,
      "frontend/components/cfo/workspace/PeriodsSection.tsx": 3,
      "frontend/pages/cfo/FinancialStatements.tsx": 1,
    });
    const host = read("frontend/components/cfo/upload/UploadFlowHost.tsx").replace(/\s+/g, " ");
    // …where a job finishes ANALYSED, before it is announced.
    const finished = host.slice(host.indexOf("if (done) { void queryClient.invalidateQueries"), host.indexOf("pushUploadNotice("));
    expect(finished).toContain("if (job.periodId) resetPeriodAnswers(queryClient, job.periodId);");
    statesChecked += 4;
  });
});

// ── Both languages carry every sentence ───────────────────────────────

describe("every new sentence exists in English and in Romanian", () => {
  const KEYS: Record<string, string[]> = {
    columnsRefused: [],
    columnsFailed: [],
    colComparison: [],
    notMeaningful: [],
    "share.marginNotMeaningful": [],
    baseRevenue: [],
    baseAssets: [],
    failedTitle: [],
    failedBody: ["status"],
    failedBodyNoResponse: [],
    failedRetry: [],
    backwardsLater: ["prior", "current"],
    backwardsLaterPlain: ["prior", "current"],
    backwardsUnknown: [],
    backwardsUnknownPlain: [],
    onlyCurrent: [],
    onlyComparison: [],
    "share.notServed": [],
    "share.noBasePl": [],
    "share.noBaseBs": [],
    "share.absent": [],
    "share.refused": [],
    "share.notAtLevel": [],
    "share.unavailable": [],
    "share.definitionDiffers": [],
  };

  it("each key, with its placeholders, in both bundles — the two differ, and Romanian is informal", () => {
    for (const [key, slots] of Object.entries(KEYS)) {
      const e = text("en", `statements.cmp.${key}`);
      const r = text("ro", `statements.cmp.${key}`);
      expect(e.trim().length > 0 && r.trim().length > 0, key).toBe(true);
      expect(r, `statements.cmp.${key} is the same string in both languages`).not.toBe(e);
      for (const s of slots) {
        expect(e, `en ${key}`).toContain(`{{${s}}}`);
        expect(r, `ro ${key}`).toContain(`{{${s}}}`);
      }
      expect(r, `ro ${key}: formal register`).not.toMatch(/încărcați|alegeți|reîncărcați|vă rugăm|dumneavoastră/i);
      statesChecked += 1;
    }
    // The cash-flow tab's word for a refused prior is the bundle's, not a
    // literal ("refused" was printed on a Romanian screen).
    const cells = read("frontend/components/cfo/ComparativeCells.tsx").replace(/\s+/g, " ");
    expect(cells).toContain('data-cmp-refused="" title={priorRefused}>{t("statements.cmp.refused")}</span>');
    expect(cells).not.toMatch(/>refused<\/span>/);
    expect(text("ro", "statements.cmp.refused")).toBe("refuzat");
    expect(text("en", "statements.cmp.refused")).toBe("refused");
    // The bridge's end row is a label and a month: the same shape in both.
    for (const lang of ["en", "ro"] as const) {
      expect(text(lang, "statements.cmp.bridgePeriod")).toBe("{{label}} — {{period}}");
    }
  });
});
