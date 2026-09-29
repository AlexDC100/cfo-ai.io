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
// REDS ON (TC-11): `runDcf` or the Cash Flow builder reading
// `assembled_pl.depreciation` ahead of `assembled_cf.depreciation`; the
// add-back row named "D&A" over a figure that holds the provision charges,
// or named for them on a book that posts none.
// CANNOT SEE: whether the engine's figures are right (provisions-symmetric);
// the engine's stabilised FCF (NI + ΔWC) against this one (CFO − 68x) —
// they differ by the walk's provision movement, a separate question; the
// /report page's row (comprehensiveReportAddBack.test.tsx); pixels.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import * as XLSX from "xlsx";

import i18n from "@/i18n";
import { renderWithProviders } from "@/test/renderWithProviders";
import { adoptRemoteViewMode } from "@/lib/viewMode";
import { CashFlowStatementView } from "@/components/cfo/CashFlowStatementView";
import { buildCashFlowStatement } from "@/lib/buildCashFlowStatement";
import { cashFlowFigures } from "@/lib/cfStructure";
import { runDcf } from "@/lib/financialValuation";
import { buildExcelWorkbook } from "@/lib/financialExports";
import type { Statements } from "@/lib/financialReport";

import { BOOKS, statementsFor, type Book } from "./exportBooks";

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
  return buildCashFlowStatement({
    pl: b.s.assembled_pl as Record<string, number>,
    bs: b.s.assembled_bs as Record<string, number>,
    cf: b.s.assembled_cf as Record<string, number>,
    entity: "E",
    period: "P",
    currency: "RON",
  });
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
