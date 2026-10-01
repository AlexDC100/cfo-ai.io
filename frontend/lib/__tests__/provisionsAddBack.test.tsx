// GATE one-ebitda (owner ruling R2, 2026-09-28) — THE NON-CASH ADD-BACK IS
// THE CASH FLOW'S, NEVER THE NARROWED P&L D&A.
//
// THE RULING. The 6812 / 6814 provision charges AND the 7812 / 7814
// reversals sit outside EBITDA on their own net-provisions line; EBIT is
// unchanged. After it the engine serves TWO depreciation figures:
//   · `assembled_pl.depreciation` — D&A WITHOUT the 6812 / 6814 charges;
//   · `assembled_cf.depreciation` — the cash-flow walk's non-cash add-back,
//     all of 68x (the charges are non-cash too).
// The engine's own DCF (`src/engine/api/_valuation.py`) reads the cash
// flow's figure first — "never a narrower one".
//
// THE DEFECTS (deploy-readiness review of feat/rulings-2, 2026-09-29):
//   1. `runDcf` (the Valuation tab, the workbook's Valuation sheet)
//      stabilised FCF as `assembled_cf.cash_from_operating −
//      assembled_pl.depreciation`: the CFO had added back all of 68x and
//      the DCF took back only the narrowed D&A, so the 6812 / 6814 charges
//      stayed inside the perpetuity base and the client DCF moved off the
//      engine's printed on the same page.
//   2. The Cash Flow tab (`buildCashFlowStatement`) added back
//      `pl.depreciation ?? cf.depreciation`: the narrowed figure, so the
//      add-back and "CF before WC changes" were short by the charges and
//      the difference landed in "WC reconciliation (other unmodeled
//      accounts)". The row carrying all of 68x was still named
//      "Depreciation & amortization" on the tab, the report page and the
//      workbook.
//
// LAW, on the four firm books (real engine output, the shape production
// serves — exportBooks.statementsFor):
//   · the DCF's stabilised FCF is `cash_from_operating −
//     assembled_cf.depreciation` to the cent, and every DCF figure (the
//     base, EV, equity, the workbook's Enterprise value cell) is the same
//     whether the served P&L carries the narrowed D&A, the cash flow's, or
//     none — the P&L's narrowing never reaches the DCF;
//   · the Cash Flow tab adds back `assembled_cf.depreciation`, "CF before
//     WC changes" is the net result plus it, and the row is named for what
//     it sums — "Depreciation, amortisation and provision charges (68x)" /
//     "Amortizări și provizioane (68x)" — exactly on the books whose two
//     figures differ; plain D&A on the book that posts no charges; the
//     workbook's Cash Flow sheet names its row the same way.
//
//   · the Cash Flow tab's label widens when only the PRIOR column's add-back
//     holds the charges (a comparison against a book that posts them);
//   · the widened row carries no D&A-only explainer: no Simple-mode
//     "depreciation" glossary tooltip over the label, no D&A learn popover
//     ("Σ account 681") over the figure — the plain row keeps both;
//   · THE SECOND STEP of the add-back order: with `assembled_cf.depreciation`
//     absent, the Cash Flow builder and `runDcf` take `assembled_pl.depreciation`
//     — never 0, never the legacy all-68x mirror;
//   · the alert trace tooltip over a cited `depreciation` fact (the P&L's
//     narrowed D&A) names the row by the pack's D&A name and lists none of
//     the ruled provision accounts (it said "(6811/6812)");
//   · the Valuation tab's FCF snapshot tile (review 2026-10-01) prints the
//     same add-back under the Cash Flow tab's own name for it — "+ D&A" /
//     "+ Amortizare" only on the book that posts no charges — both from the
//     engine's `fcf_breakdown` and from the client fallback, EN and RO.
//
// REDS ON (TC-11): `runDcf` or the Cash Flow builder reading
// `assembled_pl.depreciation` ahead of `assembled_cf.depreciation`, or
// skipping it when the cash flow's is absent; the add-back row or the
// Valuation tile named "D&A" over a figure that holds the provision charges,
// or named for them on a book that posts none; the comparison's prior
// ignored by the label; a D&A explainer over the widened row.
// CANNOT SEE: whether the engine's figures are right (provisions-symmetric);
// the engine's stabilised FCF (NI + ΔWC) against this one (CFO − 68x) —
// they differ by the walk's provision movement, ticketed with moving the
// client DCF into the engine (CLAUDE.md §25); in the second-step case, that
// a canonical CFO served without its own add-back (not an engine shape —
// the walk serves both) would still pair the narrowed D&A with it; the
// `fcf_breakdown` here is CONSTRUCTED the way the engine builds it
// (`_valuation.py` reads `assembled_cf.depreciation` first) — the engine
// side is pinned by provisions-symmetric; the /report page's row
// (comprehensiveReportAddBack.test.tsx); pixels.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import * as XLSX from "xlsx";

import i18n from "@/i18n";
import { renderWithProviders } from "@/test/renderWithProviders";
import { adoptRemoteViewMode } from "@/lib/viewMode";
import { CashFlowStatementView } from "@/components/cfo/CashFlowStatementView";
import { ComparativeProvider } from "@/components/cfo/ComparativeCells";
import { ValuationPanel } from "@/pages/cfo/FinancialStatements";
import type { ComparativesResponse } from "@/lib/comparatives";
import { buildCashFlowStatement } from "@/lib/buildCashFlowStatement";
import { cashFlowFigures } from "@/lib/cfStructure";
import { runDcf } from "@/lib/financialValuation";
import { buildExcelWorkbook } from "@/lib/financialExports";
import type { Statements } from "@/lib/financialReport";

import { FACT_TO_SOURCE } from "@/lib/linkifyAlertBody";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BOOKS, statementsFor, type Book } from "./exportBooks";
import pairJson from "./fixtures/comparatives/pair_served.json";

vi.setConfig({ testTimeout: 60_000 });

const CENT = 0.005;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type Rec = Record<string, unknown>;
const num = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} is not a served number: ${String(v)}`);
  return v;
};

interface Served {
  book: Book;
  s: Statements;
  apl: Rec;
  acf: Rec;
  plDep: number;
  cfDep: number;
  charges: number;
}

function served(book: Book): Served {
  const s = statementsFor(book) as Statements;
  const apl = (s.assembled_pl ?? {}) as Rec;
  const acf = (s.assembled_cf ?? {}) as Rec;
  const np = apl.net_provisions as { charges?: { value?: unknown } } | undefined;
  return {
    book,
    s,
    apl,
    acf,
    plDep: num(apl.depreciation, `${book} assembled_pl.depreciation`),
    cfDep: num(acf.depreciation, `${book} assembled_cf.depreciation`),
    charges: num(np?.charges?.value ?? 0, `${book} net_provisions.charges`),
  };
}

const SERVED = BOOKS.map((b) => served(b));
/** The books that post 6812 / 6814 charges: their two figures differ. */
const WITNESSES = SERVED.filter((b) => Math.abs(b.cfDep - b.plDep) >= CENT);

/** The same book with the P&L's depreciation replaced (the pre-R2 shape:
 *  both figures all of 68x) or removed. */
function withPlDepreciation(b: Served, v: number | undefined): Statements {
  const s = clone(b.s);
  const apl = { ...(s.assembled_pl ?? {}) } as Record<string, number>;
  if (v === undefined) delete apl.depreciation;
  else apl.depreciation = v;
  return { ...s, assembled_pl: apl };
}

function sheetRow(wb: XLSX.WorkBook, sheet: string, label: string): unknown[] | undefined {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1 });
  return rows.find((r) => String((r as unknown[])[0] ?? "") === label) as unknown[] | undefined;
}

function cfStatementOf(b: Served) {
  return cfStatementOfStatements(b.s);
}
function cfStatementOfStatements(s: Statements) {
  return buildCashFlowStatement({
    pl: s.assembled_pl as Record<string, number>,
    bs: s.assembled_bs as Record<string, number>,
    cf: s.assembled_cf as Record<string, number>,
    entity: "E",
    period: "P",
    currency: "RON",
  });
}

/** The same book with the cash flow's own add-back removed — the second
 *  step of the add-back order is then the one read. */
function withoutCfDepreciation(b: Served): Statements {
  const s = clone(b.s);
  const acf = { ...(s.assembled_cf ?? {}) } as Record<string, number>;
  delete acf.depreciation;
  return { ...s, assembled_cf: acf };
}

const ADD_BACK_LABEL = {
  en: { withCharges: "+ Depreciation, amortisation and provision charges (68x)", plain: "+ Depreciation & amortization" },
  ro: { withCharges: "+ Amortizări și provizioane (68x)", plain: "+ Amortizare & depreciere" },
} as const;
const TILE_LABEL = {
  en: { withCharges: ADD_BACK_LABEL.en.withCharges, plain: "+ D&A" },
  ro: { withCharges: ADD_BACK_LABEL.ro.withCharges, plain: "+ Amortizare" },
} as const;

/** The engine's `fcf_breakdown` for this book, CONSTRUCTED as
 *  `_valuation.py` builds it: the add-back is the cash flow's
 *  (`assembled_cf.depreciation`, read first since R2). */
function fcfBreakdownOf(b: Served) {
  const ni = num(b.apl.net_income_statutory, `${b.book} net_income_statutory`);
  const cfo = num(b.acf.cash_from_operating, `${b.book} cash_from_operating`);
  return {
    net_income: ni,
    depreciation: b.cfDep,
    net_wc_change: cfo - ni - b.cfDep,
    cash_from_operating: cfo,
    capex_real: -0,
    free_cash_flow: cfo,
    is_development_phase: false,
    stabilized_fcf: cfo - b.cfDep,
  };
}

// The add-back is a DETAIL row: Simple mode folds it away. The tab is read
// in Pro, where every row renders.
beforeAll(() => adoptRemoteViewMode("pro"));
afterAll(() => {
  try { window.localStorage.removeItem("cfo-view-mode-v1"); } catch { /* jsdom */ }
});
afterEach(() => {
  cleanup();
});

describe("provisions add-back — the witnesses exist", () => {
  it("three firm books post 6812 / 6814 charges: the cash flow's add-back exceeds the P&L's D&A by exactly them", () => {
    expect(WITNESSES.map((b) => b.book).sort()).toEqual(["agras", "carniprod", "retail"]);
    for (const b of WITNESSES) {
      expect(b.charges, `${b.book}: the served charges`).toBeGreaterThan(1);
      expect(Math.abs(b.cfDep - b.plDep - b.charges), `${b.book}: 68x − D&A = the charges`).toBeLessThan(CENT);
    }
    // The control: the book that posts none carries one figure.
    const control = SERVED.filter((b) => !WITNESSES.includes(b)).map((b) => b.book);
    expect(control).toEqual(["realestate"]);
  });
});

describe("provisions add-back — the DCF takes back the add-back its CFO carries", () => {
  for (const b of SERVED) {
    it(`${b.book}: stabilised FCF = CFO − assembled_cf.depreciation, whatever the P&L's D&A`, () => {
      const dcf = runDcf(b.s);
      const cfo = num(b.acf.cash_from_operating, `${b.book} cash_from_operating`);
      const stabilised = cfo - b.cfDep;
      // Non-vacuity on the witnesses: the base is positive (not floored at
      // 0) and the narrowed read would move it by the charges.
      expect(dcf.refusal, `${b.book}: the DCF is formed`).toBeNull();
      expect(dcf.baseFcf).not.toBeNull();
      expect(Math.abs((dcf.baseFcf as number) - Math.max(stabilised, 0)), `${b.book}: base FCF`).toBeLessThan(CENT);
      if (WITNESSES.includes(b)) {
        expect(stabilised, `${b.book}: a positive base`).toBeGreaterThan(0);
        expect(Math.abs((dcf.baseFcf as number) - (cfo - b.plDep)), `${b.book}: the narrowed read would differ`)
          .toBeGreaterThan(1);
      }
      // The P&L's narrowing never reaches the DCF: the pre-R2 shape (the
      // P&L's D&A = all of 68x) and a P&L with no depreciation at all value
      // the company identically.
      for (const [shape, v] of [["pre-R2", b.cfDep], ["no P&L D&A", undefined]] as const) {
        const other = runDcf(withPlDepreciation(b, v));
        for (const k of ["baseFcf", "enterpriseValue", "equityValue", "terminalValuePresent"] as const) {
          expect(other[k], `${b.book} (${shape}): ${k}`).toBe(dcf[k]);
        }
      }
      // The workbook's Valuation sheet prints this DCF.
      const wb = buildExcelWorkbook(b.s);
      const ev = sheetRow(wb, "Valuation", "Enterprise value")?.[3];
      expect(typeof ev === "number" ? Math.abs(ev - (dcf.enterpriseValue as number)) : ev, `${b.book}: workbook EV`)
        .toBeLessThan(CENT);
    });
  }
});

describe("provisions add-back — the Cash Flow tab adds back all of 68x and says so", () => {
  for (const b of SERVED) {
    it(`${b.book}: the add-back is assembled_cf.depreciation and CF before WC changes is built on it`, () => {
      const st = cashFlowFigures(cfStatementOf(b));
      expect(st, `${b.book}: a statement of figures`).not.toBeNull();
      const op = st!.operating;
      const ni = num(b.apl.net_income_statutory, `${b.book} net_income_statutory`);
      expect(Math.abs((op.depreciation as number) - b.cfDep), `${b.book}: the add-back`).toBeLessThan(CENT);
      expect(Math.abs((op.cfBeforeWcChanges as number) - (ni + b.cfDep)), `${b.book}: CF before WC`).toBeLessThan(CENT);
      expect(op.depreciationIncludesProvisionCharges ?? false, `${b.book}: the label flag`)
        .toBe(WITNESSES.includes(b));
    });

    it(`${b.book}: the row is named for what it sums — the tab (EN, RO) and the workbook`, async () => {
      const withCharges = WITNESSES.includes(b);
      for (const [lang, expected] of [
        ["en", withCharges ? "+ Depreciation, amortisation and provision charges (68x)" : "+ Depreciation & amortization"],
        ["ro", withCharges ? "+ Amortizări și provizioane (68x)" : "+ Amortizare & depreciere"],
      ] as const) {
        await i18n.changeLanguage(lang);
        renderWithProviders(<CashFlowStatementView statement={cfStatementOf(b)} hideGuide />);
        expect(screen.getByTestId("cf-depreciation-label").textContent, `${b.book} (${lang})`).toBe(expected);
        cleanup();
      }
      await i18n.changeLanguage("en");
      const wb = buildExcelWorkbook(b.s);
      const label = withCharges
        ? "+ Depreciation, amortisation and provision charges (68x)"
        : "+ Depreciation & amortization";
      const row = sheetRow(wb, "Cash Flow", label);
      expect(row, `${b.book}: the workbook's Cash Flow row "${label}"`).toBeDefined();
      expect(Math.abs((row![1] as number) - b.cfDep), `${b.book}: the workbook's add-back`).toBeLessThan(CENT);
    });
  }
});

describe("provisions add-back — the second step of the order: the P&L's D&A when the cash flow's is absent", () => {
  for (const b of WITNESSES) {
    it(`${b.book}: with assembled_cf.depreciation absent, the builder and runDcf take assembled_pl.depreciation`, () => {
      const s = withoutCfDepreciation(b);
      // Non-vacuity: the legacy mirror the third step would read is not the
      // P&L's figure, and neither is 0.
      expect(Math.abs(s.incomeStatement.depreciationAmortization - b.plDep), `${b.book}: the legacy mirror differs`)
        .toBeGreaterThan(1);
      expect(b.plDep).toBeGreaterThan(1);

      const st = cashFlowFigures(cfStatementOfStatements(s));
      expect(st, `${b.book}: a statement of figures`).not.toBeNull();
      const op = st!.operating;
      const ni = num(b.apl.net_income_statutory, `${b.book} net_income_statutory`);
      expect(Math.abs((op.depreciation as number) - b.plDep), `${b.book}: the builder's add-back`).toBeLessThan(CENT);
      expect(Math.abs((op.cfBeforeWcChanges as number) - (ni + b.plDep)), `${b.book}: CF before WC`).toBeLessThan(CENT);
      // One figure, nothing to tell apart: the row is plain D&A.
      expect(op.depreciationIncludesProvisionCharges ?? false, `${b.book}: the label flag`).toBe(false);

      const dcf = runDcf(s);
      const cfo = num(b.acf.cash_from_operating, `${b.book} cash_from_operating`);
      expect(dcf.refusal, `${b.book}: the DCF is formed`).toBeNull();
      expect(Math.abs((dcf.baseFcf as number) - Math.max(cfo - b.plDep, 0)), `${b.book}: runDcf subtracts the P&L's D&A`)
        .toBeLessThan(CENT);
    });
  }
});

describe("provisions add-back — the Cash Flow tab's label follows the comparison's prior too", () => {
  it("a book posting no charges compared with one that does: the widened name, from the prior column", async () => {
    const current = SERVED.find((b) => b.book === "realestate")!;
    const prior = WITNESSES.find((b) => b.book === "agras")!;
    const doc = clone(pairJson as unknown as { comparatives: ComparativesResponse }).comparatives;
    // Non-vacuity: alone, the current book's row is plain D&A.
    await i18n.changeLanguage("en");
    renderWithProviders(<CashFlowStatementView statement={cfStatementOf(current)} hideGuide />);
    expect(screen.getByTestId("cf-depreciation-label").textContent).toBe(ADD_BACK_LABEL.en.plain);
    cleanup();
    try {
      for (const lang of ["en", "ro"] as const) {
        await i18n.changeLanguage(lang);
        renderWithProviders(
          <ComparativeProvider doc={doc} columns={{ prior: true, delta: true, deltaPct: false, share: false }} statement="PL" currency="RON">
            <CashFlowStatementView statement={cfStatementOf(current)} prior={cfStatementOf(prior)} hideGuide />
          </ComparativeProvider>,
        );
        expect(screen.getByTestId("cf-depreciation-label").textContent, lang).toBe(ADD_BACK_LABEL[lang].withCharges);
        cleanup();
      }
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

describe("provisions add-back — no D&A-only explainer over the widened row", () => {
  for (const b of SERVED) {
    it(`${b.book}: Simple mode's glossary tooltip and the D&A learn popover only over plain D&A`, async () => {
      const withCharges = WITNESSES.includes(b);
      await i18n.changeLanguage("en");
      try {
        // Pro: the learn popover over the figure.
        const { container } = renderWithProviders(<CashFlowStatementView statement={cfStatementOf(b)} hideGuide />);
        const row = screen.getByTestId("cf-depreciation-label").closest<HTMLElement>(".cf-row")!;
        expect(row.querySelector('[data-testid="learnable-depreciation_amortization"]') !== null,
          `${b.book}: the D&A learn popover`).toBe(!withCharges);
        expect(container.textContent).toContain(withCharges ? ADD_BACK_LABEL.en.withCharges : ADD_BACK_LABEL.en.plain);
        cleanup();
        // Simple, every line shown: the glossary tooltip over the label.
        adoptRemoteViewMode("simple");
        renderWithProviders(<CashFlowStatementView statement={cfStatementOf(b)} hideGuide />);
        fireEvent.click(screen.getByTestId("cf-show-all"));
        const label = screen.getByTestId("cf-depreciation-label");
        expect(label.closest("[data-term]")?.getAttribute("data-term") ?? null, `${b.book}: the Simple-mode term`)
          .toBe(withCharges ? null : "depreciation");
      } finally {
        cleanup();
        adoptRemoteViewMode("pro");
      }
    });
  }
});

describe("provisions add-back — the Valuation tab's FCF tile names the add-back it prints", () => {
  for (const b of SERVED) {
    it(`${b.book}: the tile from the engine's fcf_breakdown and from the client fallback, EN and RO`, async () => {
      const withCharges = WITNESSES.includes(b);
      // The client fallback's add-back (no fcf_breakdown) is the legacy
      // all-68x mirror: on the witnesses it is the cash flow's figure.
      expect(Math.abs(b.s.incomeStatement.depreciationAmortization - b.cfDep), `${b.book}: the fallback's figure`)
        .toBeLessThan(CENT);
      try {
        for (const [source, valuation] of [
          ["fcf_breakdown", { fcf_breakdown: fcfBreakdownOf(b) }],
          ["client fallback", null],
        ] as const) {
          for (const lang of ["en", "ro"] as const) {
            await i18n.changeLanguage(lang);
            renderWithProviders(<ValuationPanel statements={b.s} valuation={valuation as never} />);
            const tile = screen.getByTestId("valuation-add-back-tile");
            const label = tile.firstElementChild?.textContent ?? "";
            expect(label, `${b.book} (${source}, ${lang})`).toBe(
              withCharges ? TILE_LABEL[lang].withCharges : TILE_LABEL[lang].plain);
            expect(tile.getAttribute("data-add-back-holds-provision-charges"), `${b.book} (${source})`)
              .toBe(withCharges ? "true" : "false");
            // The figure is the add-back the name describes; no D&A-only
            // popover over the widened one.
            const figure = (tile.children[1]?.textContent ?? "").replace(/\D/g, "");
            expect(figure, `${b.book} (${source}, ${lang}): the printed add-back`)
              .toBe(Math.round(b.cfDep).toString());
            expect(tile.querySelector('[data-testid="learnable-depreciation_amortization"]') !== null,
              `${b.book} (${source}): the D&A learn popover`).toBe(!withCharges);
            cleanup();
          }
        }
      } finally {
        cleanup();
        await i18n.changeLanguage("en");
      }
    });
  }
});

describe("provisions add-back — the alert trace tooltip names the P&L's D&A as the pack does", () => {
  it("the depreciation fact's hint: the pack's D&A name, none of the ruled provision accounts", () => {
    const pack = readFileSync(resolve(__dirname, "../../../packs/ro/pl_definition.yaml"), "utf-8");
    const list = (key: string): string[] => {
      const m = pack.match(new RegExp(`\\n\\s+${key}:\\s*\\[([^\\]]*)\\]`));
      if (!m) throw new Error(`pl_definition.yaml carries no ${key} list`);
      return m[1].split(",").map((c) => c.trim().replace(/"/g, "")).filter(Boolean);
    };
    const daName = pack.match(/\ndepreciation:\n\s+#[^\n]*\n(?:\s+#[^\n]*\n)*\s+name:\n\s+ro:[^\n]*\n\s+en:\s*"([^"]+)"/);
    expect(daName, "the pack's D&A name").not.toBeNull();
    const ruled = [...list("charges"), ...list("reversals")];
    expect(ruled.length, "the pack's ruled accounts").toBeGreaterThanOrEqual(4);

    const source = FACT_TO_SOURCE.depreciation;
    expect(source.statement).toBe("pl");
    expect(source.bucket).toBe("depreciationAmortization");
    const hint = source.hint ?? "";
    expect(hint.startsWith(daName![1]), `"${hint}" names the row as the pack does: "${daName![1]}"`).toBe(true);
    for (const code of ruled) expect(hint, `the hint lists ${code}`).not.toContain(code);
  });
});
