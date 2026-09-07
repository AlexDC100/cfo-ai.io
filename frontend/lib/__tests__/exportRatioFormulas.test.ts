// G4 — EVERY RENDERED RATIO EQUALS ITS STATED FORMULA.
//
// Twenty-two ratios go into the printed report and, until 2026-09-07,
// not one of them said what it was. A label and a benchmark band, and
// nothing a reader could check the figure against. That is how the
// document came to print, three pages apart on the agras book:
//
//   §Debt Coverage card   "Interest Coverage"                  66.28×
//   §Credit component row "Interest Coverage (EBIT / Interest)"  —
//
// where 66.28× is EBITDA ÷ interest (18,420,491.28 / 277,930.35) and the
// component's own basis, EBIT ÷ interest, is 55.64× (15,465,144.89 /
// 277,930.35). Two bases, two numbers, one name, no formula anywhere.
//
// Same class, quieter: "Quick Ratio 0.74× — Watch". The served value is
// (cash + trade receivables) ÷ current liabilities. The textbook
// (current assets − inventory) ÷ current liabilities is 1.42× on the same
// book — Healthy. The verdict a reader takes away was decided by a
// definition the page did not state.
//
// THIS GATE HOLDS ITS OWN ARITHMETIC. Every expectation below is written
// out from `assembled_pl` / `assembled_bs` — the served envelope — and
// compared against the figure the document printed. It is a second
// opinion, not a restatement: nothing here calls `computeRatios` to
// decide what the answer should be.
//
// AND IT PROVES THE ANCHOR. For every ratio whose numerator is net
// income, the gate recomputes it BOTH ways — on the filed account-121
// figure and on the class-6/7 reconstruction — and requires the rendered
// value to match the former and NOT the latter. The two differ on all
// four books (agras ROE 31.5 % against 59.0 %), so the assertion is not
// vacuous on any of them.
//
// WHAT IT REDS ON, after the repair (TC-11): a ratio re-sourced to a
// different engine metric without its printed formula following; a
// formula edited without the arithmetic; a net-income ratio quietly
// re-pointed at the reconstruction; a new ratio row added to the printed
// document with no entry here (the coverage assertion counts the cards).
//
// WHAT IT CANNOT SEE: whether a formula is the RIGHT one for the name
// above it — that is a judgement, made in this file's own table and
// stated in the wave report, not something a gate can decide. It also
// does not recompute Altman Z″: that figure comes from the credit
// reader's own model, is asserted end-to-end by
// `oneVerdictLeavesTheBuilding.test.tsx`, and only its formula string is
// checked here.

import { describe, expect, it } from "vitest";

import {
  BOOKS,
  type Book,
  cardNamed,
  exportDoc,
  parsePrinted,
  ratioCards,
  statementsFor,
} from "./exportBooks";

type Env = {
  pl: Record<string, number>;
  bs: Record<string, number>;
  days: number;
};

interface Spec {
  key: string;
  /** The label the card prints. */
  label: string | ((e: Env) => string);
  /** The formula the card prints, verbatim. */
  formula: string;
  unit: "x" | "%" | "days";
  /** This gate's own arithmetic, from the served envelope. */
  recompute: (e: Env) => number | null;
  /** When set, the same arithmetic on the class-6/7 reconstruction —
   *  the value the card must NOT be showing. */
  onReconstruction?: (e: Env) => number | null;
}

const div = (a: number | undefined, b: number | undefined): number | null =>
  typeof a === "number" && typeof b === "number" && b !== 0 ? a / b : null;

const SPECS: Spec[] = [
  {
    key: "current_ratio",
    label: "Current Ratio",
    formula: "current assets ÷ current liabilities",
    unit: "x",
    recompute: (e) => div(e.bs.total_current_assets, e.bs.total_current_liabilities),
  },
  {
    key: "quick_ratio",
    label: "Quick Ratio",
    formula:
      "(cash + trade receivables) ÷ current liabilities — the acid test; other current assets are excluded, which is why this can sit a full band below (current assets − inventory) ÷ current liabilities",
    unit: "x",
    recompute: (e) => div(e.bs.cash + e.bs.accounts_receivable, e.bs.total_current_liabilities),
  },
  {
    key: "cash_ratio",
    label: "Cash Ratio",
    // ⚠ THE OLD ENTRY PINNED THE DEFECT. It read "cash ÷ current
    // liabilities" — the words the card printed — and this gate passed,
    // because the gate only ever asked whether the words matched the
    // arithmetic. They did. What neither could see is that the word
    // "cash" was doing undeclared work: it means bank balances and petty
    // cash and NOT the RON 906,526 of short-term investments (RAS class
    // 50) sitting in the same book's current assets. Counting those, the
    // agras reading moves 0.0898× → 0.159× — Critical → Watch, one band
    // either side of a choice the document never stated. The arithmetic
    // below is unchanged, which is the point: the repair was to the
    // WORDS, and this entry follows them.
    formula:
      "cash and bank balances ÷ current liabilities — cash excludes short-term investments (RAS class 50) and every other current asset",
    unit: "x",
    recompute: (e) => div(e.bs.cash, e.bs.total_current_liabilities),
  },
  {
    key: "gross_margin",
    label: "Gross Margin",
    formula: "gross profit ÷ revenue",
    unit: "%",
    recompute: (e) => {
      const v = div(e.pl.gross_profit, e.pl.revenue);
      return v === null ? null : v * 100;
    },
  },
  {
    key: "ebitda_margin",
    label: "EBITDA Margin",
    formula: "EBITDA (statutory) ÷ revenue",
    unit: "%",
    recompute: (e) => {
      const v = div(e.pl.ebitda_statutory, e.pl.revenue);
      return v === null ? null : v * 100;
    },
  },
  {
    key: "net_margin",
    label: "Net Margin",
    formula: "net profit as filed (account 121) ÷ revenue",
    unit: "%",
    recompute: (e) => {
      const v = div(e.pl.net_income_statutory, e.pl.revenue);
      return v === null ? null : v * 100;
    },
    onReconstruction: (e) => {
      const v = div(e.pl.net_income_operational, e.pl.revenue);
      return v === null ? null : v * 100;
    },
  },
  {
    key: "roa",
    label: "Return on Assets",
    formula: "net profit as filed (account 121) ÷ total assets",
    unit: "%",
    recompute: (e) => {
      const v = div(e.pl.net_income_statutory, e.bs.total_assets);
      return v === null ? null : v * 100;
    },
    onReconstruction: (e) => {
      const v = div(e.pl.net_income_operational, e.bs.total_assets);
      return v === null ? null : v * 100;
    },
  },
  {
    key: "roe",
    label: "Return on Equity",
    formula: "net profit as filed (account 121) ÷ total equity",
    unit: "%",
    recompute: (e) => {
      const v = div(e.pl.net_income_statutory, e.bs.total_equity);
      return v === null ? null : v * 100;
    },
    onReconstruction: (e) => {
      const v = div(e.pl.net_income_operational, e.bs.total_equity);
      return v === null ? null : v * 100;
    },
  },
  {
    key: "roic",
    label: "Return on Invested Capital",
    formula:
      "EBIT × (1 − 16% tax) ÷ (total debt + total equity) — NOPAT over invested capital. Net profit is NOT an input: this ratio does not move with the account-121 anchor and is not expected to.",
    unit: "%",
    recompute: (e) => {
      const v = div(e.pl.operating_ebit * 0.84, e.bs.total_debt + e.bs.total_equity);
      return v === null ? null : v * 100;
    },
  },
  {
    key: "debt_to_ebitda",
    label: "Debt / EBITDA",
    formula: "total debt ÷ EBITDA (statutory)",
    unit: "x",
    recompute: (e) => div(e.bs.total_debt, e.pl.ebitda_statutory),
  },
  {
    key: "debt_to_equity",
    label: "Debt / Equity",
    formula: "total debt ÷ total equity",
    unit: "x",
    recompute: (e) => div(e.bs.total_debt, e.bs.total_equity),
  },
  {
    key: "equity_ratio",
    label: "Equity Ratio",
    formula: "total equity ÷ total assets",
    unit: "%",
    recompute: (e) => {
      const v = div(e.bs.total_equity, e.bs.total_assets);
      return v === null ? null : v * 100;
    },
  },
  {
    key: "ltv",
    label: "Debt-to-Assets",
    formula: "total debt ÷ total assets",
    unit: "%",
    recompute: (e) => {
      const v = div(e.bs.total_debt, e.bs.total_assets);
      return v === null ? null : v * 100;
    },
  },
  {
    key: "interest_coverage",
    label: "Interest Coverage (EBITDA / Interest)",
    formula:
      "EBITDA (statutory) ÷ interest expense — NOT EBIT ÷ interest, which the credit component below bands on and which is a different number on every levered book",
    unit: "x",
    recompute: (e) => div(e.pl.ebitda_statutory, e.pl.interest_expense),
  },
  {
    key: "dscr",
    label: "DSCR (interest + ST debt)",
    formula: "EBITDA (statutory) ÷ (interest expense + short-term debt)",
    unit: "x",
    recompute: (e) => div(e.pl.ebitda_statutory, e.pl.interest_expense + e.bs.short_term_debt),
  },
  {
    key: "adjusted_dscr",
    label: "Adjusted DSCR (incl. lease)",
    // ⚠ THE OLD ENTRY PINNED THE DEFECT, AND PINNED IT WORD FOR WORD.
    // It asserted the card printed "no lease supplied — identical to
    // DSCR above" and recomputed the plain DSCR to match it, so a green
    // gate stood over a card that (a) restated the number from the card
    // directly above it under a name claiming to include a lease, and
    // (b) declared "no lease supplied" on a book whose own balance sheet
    // carries RON 887,498 in account 167 — "Datorii din leasing
    // financiar" per `packs/ro/omfp1802-v1/classification.yaml:107`.
    // `supplementary.annualLeaseExpense` is a round-tripped USER
    // ASSUMPTION, so its absence is a statement about the inputs, never
    // about the company. The lease-adjusted view is now UNDEFINED
    // without it, and `recompute` returns null so this gate reds if the
    // card ever prints a figure for it again on a book that supplies no
    // lease charge. All four committed books supply none.
    formula:
      "(EBITDA + annual lease expense) ÷ (interest expense + short-term debt + annual lease expense) — not computed: no annual lease expense was supplied for this period",
    unit: "x",
    recompute: () => null,
  },
  {
    key: "dscr_with_lt_principal",
    label: "DSCR (incl. LT principal proxy)",
    formula:
      "EBITDA (statutory) ÷ (interest expense + long-term debt ÷ 8, a ~10-year amortization proxy)",
    unit: "x",
    recompute: (e) =>
      div(e.pl.ebitda_statutory, e.pl.interest_expense + e.bs.long_term_debt / 8),
  },
  {
    key: "dso",
    label: "Days Sales Outstanding",
    formula: "trade receivables ÷ revenue × 365 days",
    unit: "days",
    recompute: (e) => {
      const v = div(e.bs.accounts_receivable, e.pl.revenue);
      return v === null ? null : v * e.days;
    },
  },
  {
    key: "dio",
    label: "Days Inventory Outstanding",
    formula:
      "inventory ÷ TOTAL operating expense (COGS + opex + D&A) × 365 days — not narrow COGS",
    unit: "days",
    recompute: (e) => {
      const v = div(e.bs.inventory, e.pl.total_operating_expense);
      return v === null ? null : v * e.days;
    },
  },
  {
    key: "dpo",
    // THE LABEL NAMES THE DENOMINATOR, and that is R1 across surfaces,
    // not decoration: the insight engine's `trade_float` detector
    // computes DPO on cost of goods sold over a narrower payables base
    // and reads 37.2 days on this same agras book, against the 26.6 days
    // this row computes. Two bases cannot share one name in one
    // document.
    label: "Days Payables Outstanding (on total operating cost)",
    formula:
      "trade payables ÷ TOTAL operating expense (COGS + opex + D&A) × 365 days — not narrow COGS",
    unit: "days",
    recompute: (e) => {
      const v = div(e.bs.accounts_payable, e.pl.total_operating_expense);
      return v === null ? null : v * e.days;
    },
  },
  {
    key: "ccc",
    label: "Cash Conversion Cycle",
    formula: "DSO + DIO − DPO",
    unit: "days",
    recompute: (e) => {
      const dso = div(e.bs.accounts_receivable, e.pl.revenue);
      const dio = div(e.bs.inventory, e.pl.total_operating_expense);
      const dpo = div(e.bs.accounts_payable, e.pl.total_operating_expense);
      if (dso === null || dio === null || dpo === null) return null;
      return (dso + dio - dpo) * e.days;
    },
  },
  {
    key: "asset_turnover",
    label: "Asset Turnover",
    formula: "revenue ÷ total assets",
    unit: "x",
    recompute: (e) => div(e.pl.revenue, e.bs.total_assets),
  },
];

/** The engine rounds the ratios it serves; the document rounds again to
 *  print them. Both are roundings, not disagreements — this is the widest
 *  either can be. */
function tolerance(unit: Spec["unit"], value: number): number {
  const served = unit === "%" ? 0.005 : 0.00005; // 4 dp on the served decimal
  const printed = unit === "%" ? 0.05 : unit === "days" ? 0.5 : 0.005;
  return served + printed + Math.abs(value) * 1e-6;
}

function envOf(book: Book): Env {
  const s = statementsFor(book);
  return {
    pl: s.assembled_pl ?? {},
    bs: s.assembled_bs ?? {},
    days: s.supplementary?.periodDays ?? 365,
  };
}

const show = (n: number, unit: Spec["unit"]) =>
  unit === "%" ? `${n.toFixed(4)}%` : unit === "days" ? `${n.toFixed(4)} d` : `${n.toFixed(4)}×`;

describe("G4 — every rendered ratio equals its stated formula", () => {
  it("declares a formula for every ratio the printed document states", () => {
    // Not vacuous, and not silently outgrown: a ratio card added to the
    // document with no spec here reds.
    const doc = exportDoc("agras");
    const formulaCards = Array.from(doc.querySelectorAll("[data-ratio-formula]")).map((el) =>
      el.getAttribute("data-ratio-formula"),
    );
    const declared = new Set([...SPECS.map((sp) => sp.key), "altman_z"]);
    const undeclared = formulaCards.filter((k) => k !== null && !declared.has(k));
    expect(undeclared, "a ratio the document prints with no entry in SPECS").toEqual([]);
    expect(SPECS.length).toBe(22);
    // Every card that states a RATIO carries a formula. The six that do
    // not are named, so a seventh cannot appear unnoticed: four executive
    // -strip cards (figures, not ratios) and the two credit cards, whose
    // arithmetic is the credit model's and is spelled by its own ladder
    // block beneath them.
    const NOT_RATIOS = [
      "Operating revenue",
      "EBITDA",
      "Net Income (account 121, as filed)",
      "Total Debt",
      "Composite credit score",
      "Letter grade",
    ];
    const cards = ratioCards(doc).map((c) => c.label);
    const unaccounted = cards.filter(
      // The Altman card's label comes off the credit reader's own
      // component, whose double-prime is U+0022 on some models and U+2033
      // on others; match the measure, not the glyph.
      (label) =>
        !NOT_RATIOS.includes(label) &&
        !SPECS.some((sp) => sp.label === label) &&
        !/^Altman /.test(label),
    );
    expect(unaccounted, "a card this gate cannot account for").toEqual([]);
    expect(formulaCards.length, "ratio cards without a printed formula").toBe(
      cards.length - NOT_RATIOS.length,
    );
  });

  for (const book of BOOKS) {
    it(`${book}: each ratio prints the formula it was computed by`, () => {
      const doc = exportDoc(book as Book);
      const failures: string[] = [];
      for (const sp of SPECS) {
        const el = doc.querySelector(`[data-ratio-formula="${sp.key}"]`);
        if (el === null) {
          failures.push(`${book}: the document prints no formula for “${sp.key}”`);
          continue;
        }
        const printedFormula = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (printedFormula !== sp.formula) {
          failures.push(
            `${book}: “${sp.key}” prints the formula ${JSON.stringify(printedFormula)} ` +
              `but this gate recomputes it as ${JSON.stringify(sp.formula)} — the words and ` +
              `the arithmetic have drifted apart`,
          );
        }
      }
      expect(failures, `${book}: a printed formula does not match the arithmetic`).toEqual([]);
    });

    it(`${book}: each rendered value equals that formula, recomputed`, () => {
      const doc = exportDoc(book as Book);
      const env = envOf(book as Book);
      const failures: string[] = [];
      for (const sp of SPECS) {
        const label = typeof sp.label === "function" ? sp.label(env) : sp.label;
        const card = cardNamed(doc, label);
        const rendered = parsePrinted(card.value);
        const expected = sp.recompute(env);
        if (expected === null || !Number.isFinite(expected)) {
          // The formula is undefined for this book — the card must refuse,
          // not print a figure.
          if (rendered !== null) {
            failures.push(
              `${book}: “${label}” prints ${card.value} but its formula (${sp.formula}) is ` +
                `undefined on this book — a refusal was the only honest answer`,
            );
          }
          continue;
        }
        if (rendered === null) {
          failures.push(
            `${book}: “${label}” prints ${JSON.stringify(card.value)} and its formula ` +
              `recomputes to ${show(expected, sp.unit)}`,
          );
          continue;
        }
        const tol = tolerance(sp.unit, expected);
        if (Math.abs(rendered - expected) > tol) {
          failures.push(
            `${book}: “${label}” prints ${card.value} (${rendered}) but ${sp.formula} ` +
              `recomputes to ${show(expected, sp.unit)} — off by ` +
              `${Math.abs(rendered - expected).toFixed(4)}, tolerance ${tol.toFixed(4)}`,
          );
        }
      }
      expect(failures, `${book}: a rendered ratio does not equal its stated formula`).toEqual([]);
    });

    it(`${book}: every net-income ratio consumes the filed account-121 figure`, () => {
      const doc = exportDoc(book as Book);
      const env = envOf(book as Book);
      const anchored: string[] = [];
      const failures: string[] = [];
      for (const sp of SPECS) {
        if (sp.onReconstruction === undefined) continue;
        const label = typeof sp.label === "function" ? sp.label(env) : sp.label;
        const rendered = parsePrinted(cardNamed(doc, label).value);
        const onFiled = sp.recompute(env);
        const onRebuilt = sp.onReconstruction(env);
        if (rendered === null || onFiled === null || onRebuilt === null) continue;
        const tol = tolerance(sp.unit, onFiled);
        // Non-vacuity: the two bases must actually differ on this book, or
        // "it is on the anchor" is a statement about nothing.
        expect(
          Math.abs(onFiled - onRebuilt),
          `${book}: “${label}” — the filed and reconstructed bases are the same number ` +
            `(${show(onFiled, sp.unit)}), so this book cannot tell them apart`,
        ).toBeGreaterThan(tol * 4);
        anchored.push(label);
        if (Math.abs(rendered - onFiled) > tol) {
          failures.push(
            `${book}: “${label}” prints ${show(rendered, sp.unit)}; on the FILED account-121 ` +
              `figure (${env.pl.net_income_statutory.toLocaleString("en-US")}) it is ` +
              `${show(onFiled, sp.unit)} and on the class-6/7 RECONSTRUCTION ` +
              `(${env.pl.net_income_operational.toLocaleString("en-US")}) it is ` +
              `${show(onRebuilt, sp.unit)} — it is reading the reconstruction`,
          );
        }
      }
      expect(anchored.length, `${book}: no net-income ratio was compared`).toBe(3);
      expect(failures, `${book}: a ratio is built on the reconstruction, not the anchor`).toEqual(
        [],
      );
    });
  }
});
