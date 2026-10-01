// GATE pl-one-ebitda-page (owner ruling R2, 2026-09-28) — THE NET-PROVISIONS
// ROW READS ON ONE SIGN CONVENTION, CURRENT, PRIOR AND Δ.
//
// THE RULING puts the 6812 / 6814 charges and the 7812 / 7814 reversals
// outside EBITDA on their own line, "6812 + 6814 − 7812 − 7814": the engine
// serves it signed as a CHARGE (positive = a net charge, negative = a net
// release), and the comparatives endpoint's `pl.net_provisions` cell
// carries the same charge-signed prior and Δ.
//
// THE DEFECT (deploy-readiness review of feat/rulings-2, 2026-09-29). The P&L
// tab printed the CURRENT cell with its EFFECT sign — a net charge "−", a
// net release "+" — beside the charge-signed prior and Δ: on the committed
// pair (current a net charge of 131,394.66, prior a net release of
// 67,194.32) the row read "−131,394.66 | −67,194.32 | +198,588.98", both
// periods with a minus and opposite meanings, the current red and the Δ
// green. D&A beside it prints its charge unsigned with no colour, and every
// cell of its row is charge-signed.
//
// LAW, on the committed comparatives pair (a real GET /api/period body and
// its comparatives document) and on the same pair read the other way (a
// CONSTRUCTED mirror: the current a net release, the prior a net charge —
// the figures are the pair's own, swapped):
//   · the current cell prints the served charge-signed value exactly as D&A
//     prints its own: a minus only on a negative value, never a "+", no
//     pl-pos / pl-neg colour;
//   · the prior cell prints the column's prior with the same rule, the Δ cell
//     the column's Δ signed "+" / "−" — the one convention of the row;
//   · the D&A row of the same render prints the same way (the pattern the
//     row follows).
//   · THE RECONCILIATION LINE under EBITDA, a few lines above the row, prints
//     net provisions on the same convention, in English and in Romanian: the
//     row's served figure, the row's printed string, no "+" (review
//     2026-10-01: the line printed the engine's effect-signed bridge part —
//     agras "−131,394.66" above a row reading "131,394.66", under labels that
//     both say "6812 + 6814 − 7812 − 7814").
// REDS ON: an effect sign ("+" on a release, "−" on a charge) or a colour on
// the current cell; a prior or Δ cell off the engine's column; the
// reconciliation line's net-provisions part printing another sign or
// another figure than the row.
// The Valuation tab's reconciliation panel (/report Section 1 too) and the
// printed report / workbook (printedPl) are held by the second describe
// block below (review 2026-10-01).
// CANNOT SEE: whether the served figures are right (provisions-symmetric);
// pixels.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

import i18n from "@/i18n";
import { renderWithProviders } from "@/test/renderWithProviders";
import { adoptRemoteViewMode } from "@/lib/viewMode";
import { ComparativeProvider } from "@/components/cfo/ComparativeCells";
import { PLStatementView } from "@/components/cfo/PLStatementView";
import { pickPLBuilder } from "@/lib/buildPlStatement";
import type { ComparativeColumnDto, ComparativesResponse } from "@/lib/comparatives";
import type { Statements } from "@/lib/financialReport";

import pairJson from "./fixtures/comparatives/pair_served.json";

interface Pair {
  current_body: { statements: Statements };
  comparatives: ComparativesResponse;
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const COLUMNS = { prior: true, delta: true, deltaPct: true, share: true };
const MINUS = "−";

type Rec = Record<string, unknown>;

/** The served pair, and the same pair read the other way: the current's
 *  net-provisions block becomes the prior's and the column swaps with it
 *  (the prior's own block is the served prior_statements'). */
function served(): Pair {
  return clone(pairJson) as unknown as Pair;
}
function mirrored(): Pair {
  const p = served();
  const apl = p.current_body.statements.assembled_pl as unknown as Rec;
  const priorApl = (p.comparatives.prior_statements as { assembled_pl: Rec }).assembled_pl;
  const cur = apl.net_provisions;
  apl.net_provisions = priorApl.net_provisions;
  priorApl.net_provisions = cur;
  const col = p.comparatives.columns.find((c) => c.key === "pl.net_provisions")!;
  const [c, pr] = [col.prior as number, col.current as number];
  Object.assign(col, { current: c, prior: pr, delta: Math.round((c - pr) * 100) / 100 });
  // The reconciliation line's after-EBITDA part travels with its block: the
  // engine serves it effect-signed (−net provisions).
  const after = ((apl.ebitda_reconciliation as Rec).bridge as Rec).after_ebitda as Rec[];
  const part = after.find((a) => a.key === "net_provisions")!;
  part.value = -((apl.net_provisions as Rec).value as number);
  return p;
}

function renderPl(pair: Pair) {
  const statement = pickPLBuilder(
    { lineItems: [], entity: "Entity", period: "Period", currency: "RON" },
    pair.current_body.statements,
  );
  return renderWithProviders(
    <ComparativeProvider doc={pair.comparatives} columns={COLUMNS} statement="PL" currency="RON">
      <PLStatementView statement={statement} hideGuide />
    </ComparativeProvider>,
  );
}

/** The one rendered row whose engine cells carry `key`. */
function rowFor(container: HTMLElement, key: string): HTMLElement {
  const cells = Array.from(container.querySelectorAll<HTMLElement>(`.cmp-cells[data-cmp-key="${key}"]`));
  expect(cells, `exactly one row carries ${key}`).toHaveLength(1);
  return cells[0].closest<HTMLElement>(".pl-row")!;
}

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const digitsOf = (n: number) => Math.abs(n).toFixed(2).replace(/\D/g, "");
/** The sign glyph a printed money cell leads with: "−", "+" or "". */
const glyph = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  return t.startsWith(MINUS) ? MINUS : t.startsWith("+") ? "+" : "";
};
/** A charge-signed figure printed as a level: a minus only when negative. */
const levelGlyph = (v: number) => (v < 0 ? MINUS : "");

function column(pair: Pair, key: string): ComparativeColumnDto {
  return pair.comparatives.columns.find((c) => c.key === key)!;
}

/** The row's three printed money cells. */
function printed(row: HTMLElement) {
  const amount = row.querySelector<HTMLElement>(".pl-amount");
  return {
    amount,
    current: amount?.textContent ?? "",
    prior: row.querySelector(".cmp-cell--prior")?.textContent ?? "",
    delta: row.querySelectorAll<HTMLElement>(".cmp-cells > .cmp-cell")[1]?.textContent ?? "",
  };
}

beforeAll(async () => {
  adoptRemoteViewMode("pro");
  await i18n.changeLanguage("en");
});
afterAll(() => {
  cleanup();
  try { window.localStorage.removeItem("cfo-view-mode-v1"); } catch { /* jsdom */ }
});

describe("the net-provisions row — one sign convention across current, prior and Δ", () => {
  const CASES: Array<[string, () => Pair]> = [
    ["the served pair (current a net charge, prior a net release)", served],
    ["the pair read the other way (current a net release, prior a net charge — constructed)", mirrored],
  ];

  it("the witnesses: one side of each pair is a net charge and the other a net release", () => {
    for (const [name, make] of CASES) {
      const col = column(make(), "pl.net_provisions");
      expect(col.status, name).toBe("compared");
      expect(Math.sign(col.current as number) * Math.sign(col.prior as number), `${name}: opposite signs`).toBe(-1);
    }
  });

  for (const [name, make] of CASES) {
    it(`${name}: the row prints current, prior and Δ charge-signed, as D&A prints its own`, () => {
      const pair = make();
      const { container } = renderPl(pair);
      try {
        const served = (pair.current_body.statements.assembled_pl as unknown as { net_provisions: { value: number } })
          .net_provisions.value;
        const col = column(pair, "pl.net_provisions");
        expect(Math.abs((col.current as number) - served), "the column's current is the served figure").toBeLessThan(0.005);

        const np = printed(rowFor(container, "pl.net_provisions"));
        expect(digits(np.current), "current digits").toBe(digitsOf(served));
        expect(glyph(np.current), `current ${np.current}`).toBe(levelGlyph(served));
        expect(np.amount?.className ?? "", "no effect colour on the current cell").not.toMatch(/\bpl-(pos|neg)\b/);
        expect(digits(np.prior), "prior digits").toBe(digitsOf(col.prior as number));
        expect(glyph(np.prior), `prior ${np.prior}`).toBe(levelGlyph(col.prior as number));
        expect(digits(np.delta), "delta digits").toBe(digitsOf(col.delta as number));
        expect(glyph(np.delta), `delta ${np.delta}`).toBe((col.delta as number) > 0 ? "+" : MINUS);

        // The pattern the row follows: D&A, the charge beside it.
        const da = printed(rowFor(container, "pl.depreciation"));
        const daCol = column(pair, "pl.depreciation");
        expect(glyph(da.current)).toBe(levelGlyph(daCol.current as number));
        expect(da.amount?.className ?? "").not.toMatch(/\bpl-(pos|neg)\b/);
        expect(glyph(da.prior)).toBe(levelGlyph(daCol.prior as number));
      } finally {
        cleanup();
      }
    });

    it(`${name}: the reconciliation line above the row prints net provisions on the row's convention, EN and RO`, async () => {
      const pair = make();
      const apl = pair.current_body.statements.assembled_pl as unknown as Rec;
      const servedValue = (apl.net_provisions as { value: number }).value;
      // Non-vacuity: the engine's bridge part is the EFFECT-signed figure —
      // the opposite sign of the row's — so printing it would red here.
      const part = (((apl.ebitda_reconciliation as Rec).bridge as Rec).after_ebitda as Rec[])
        .find((a) => a.key === "net_provisions")!;
      expect(Math.sign(part.value as number), "the served bridge part is effect-signed").toBe(-Math.sign(servedValue));
      try {
        for (const lang of ["en", "ro"] as const) {
          await i18n.changeLanguage(lang);
          const { container } = renderPl(pair);
          const row = printed(rowFor(container, "pl.net_provisions"));
          const after = container.querySelector<HTMLElement>('[data-bridge-after="net_provisions"]');
          expect(after, `${lang}: the line carries net provisions after EBITDA`).not.toBeNull();
          const label = after!.querySelector(".pl-bridge-label")?.textContent ?? "";
          expect(label, `${lang}: the engine's label, charge arithmetic`).toContain("6812 + 6814 − 7812 − 7814");
          const value = after!.querySelector<HTMLElement>(".pl-bridge-value")!;
          expect(value.textContent, `${lang}: the line prints the row's figure, as the row prints it`).toBe(row.current);
          expect(glyph(value.textContent), `${lang}: ${value.textContent}`).toBe(levelGlyph(servedValue));
          expect(digits(value.textContent), `${lang}: the served figure`).toBe(digitsOf(servedValue));
          expect(Number(value.getAttribute("data-bridge-value")), `${lang}: the attribute is the row's figure`)
            .toBe(servedValue);
          cleanup();
        }
      } finally {
        await i18n.changeLanguage("en");
        cleanup();
      }
    });
  }
});

// ── THE VALUATION TAB'S RECONCILIATION PANEL, /report SECTION 1, AND THE
// PRINTED REPORT / WORKBOOK (review 2026-10-01) ──────────────────────────
//
// THE DEFECT. The same served bridge printed net provisions with opposite
// signs on two tabs of one dashboard: the P&L tab's line (fixed above) the
// served charge, the panel the engine's effect-signed part — agras
// "131,394.66" there, "−131,394.66" here, under labels that both say
// "6812 + 6814 − 7812 − 7814", whose own arithmetic is the charge. The
// panel's chain row and the printed P&L row did the same.
//
// LAW, on the served pair and its mirror, EN and RO:
//   · the panel's bridge part after EBITDA prints THE P&L TAB'S STRING — the
//     served charge, unsigned, uncoloured — under the engine's label;
//   · the panel's CHAIN row and the printed P&L row (report + workbook) keep
//     the effect (the chain sums to the operating result, every cost
//     negative), and the account arithmetic printed beside each EVALUATES TO
//     THE PRINTED FIGURE: each prefix replaced by the served by-account
//     amounts it names, the expression equals the figure to the cent;
//   · the printed one-line bridge carries the P&L tab's charge after EBITDA.
// REDS ON: the panel's after-part printing the effect sign or another figure
// than the P&L tab; a chain / printed row whose stated arithmetic and printed
// figure disagree in sign or amount.
import { EbitdaReconciliationPanel } from "@/components/cfo/EbitdaReconciliationPanel";
import { printedPl } from "@/lib/printedPl";

/** The served by-account amounts a prefix names (charges and reversals). */
function amountsOf(np: Rec): Map<string, number> {
  const out = new Map<string, number>();
  for (const side of ["charges", "reversals"] as const) {
    const by = ((np[side] as Rec).by_account ?? {}) as Record<string, number>;
    for (const [acct, v] of Object.entries(by)) out.set(acct, v);
  }
  return out;
}

/** Evaluate "a + b − c − d" over account prefixes, each replaced by the sum
 *  of the served by-account amounts under it. */
function evaluate(expr: string, np: Rec): number {
  const amounts = amountsOf(np);
  const tokens = expr.replace(/−/g, " − ").replace(/\+/g, " + ").trim().split(/\s+/);
  let sign = 1;
  let total = 0;
  for (const tok of tokens) {
    if (tok === "+") { sign = 1; continue; }
    if (tok === "−") { sign = -1; continue; }
    expect(tok, `"${tok}" in "${expr}" is an account prefix`).toMatch(/^\d{3,6}$/);
    let sum = 0;
    for (const [acct, v] of amounts) if (acct.startsWith(tok)) sum += v;
    total += sign * sum;
  }
  return Math.round(total * 100) / 100;
}

/** A printed signed money string read back: sign glyph and its digits. */
const readBack = (s: string | null | undefined) =>
  (glyph(s) === MINUS ? -1 : 1) * Number(digits(s)) / 100;

/** The pair with the chain line travelling with its swapped block. */
function mirroredChain(): Pair {
  const p = mirrored();
  const apl = p.current_body.statements.assembled_pl as unknown as Rec;
  const line = ((apl.ebitda_reconciliation as Rec).lines as Rec[]).find((l) => l.key === "net_provisions")!;
  line.value = -((apl.net_provisions as Rec).value as number);
  return p;
}

describe("net provisions on the Valuation tab's panel and the printed P&L — one convention per surface", () => {
  const CASES: Array<[string, () => Pair]> = [
    ["the served pair (current a net charge)", served],
    ["the pair read the other way (current a net release — constructed)", mirroredChain],
  ];

  for (const [name, make] of CASES) {
    it(`${name}: the panel's bridge after EBITDA prints the P&L tab's figure, and its chain row's arithmetic is its figure, EN and RO`, async () => {
      const pair = make();
      const apl = pair.current_body.statements.assembled_pl as unknown as Rec;
      const npBlock = apl.net_provisions as Rec;
      const servedValue = npBlock.value as number;
      // Non-vacuity: the served chain line is the EFFECT, the opposite sign.
      const chainLine = ((apl.ebitda_reconciliation as Rec).lines as Rec[]).find((l) => l.key === "net_provisions")!;
      expect(Math.sign(chainLine.value as number), "the served chain line is effect-signed").toBe(-Math.sign(servedValue));
      expect(evaluate(npBlock.accounts as string, npBlock), "the engine's arithmetic is the CHARGE").toBeCloseTo(servedValue, 2);
      try {
        for (const lang of ["en", "ro"] as const) {
          await i18n.changeLanguage(lang);
          const pl = renderPl(pair);
          const plLine = pl.container
            .querySelector<HTMLElement>('[data-testid="pl-ebitda-bridge"] [data-bridge-after="net_provisions"] .pl-bridge-value')!;
          const plString = plLine.textContent;
          cleanup();

          const { container } = renderWithProviders(
            <EbitdaReconciliationPanel statements={pair.current_body.statements} currency="RON" />,
          );
          const after = container.querySelector<HTMLElement>(
            '[data-testid="ebitda-recon-bridge"] [data-bridge-after="net_provisions"]',
          );
          expect(after, `${lang}: the panel's bridge carries net provisions after EBITDA`).not.toBeNull();
          expect(after!.textContent, `${lang}: the engine's label`).toContain("6812 + 6814 − 7812 − 7814");
          const value = after!.querySelector<HTMLElement>("[data-bridge-value]")!;
          expect(value.textContent, `${lang}: the panel prints the P&L tab's string`).toBe(plString);
          expect(glyph(value.textContent), `${lang}: ${value.textContent}`).toBe(levelGlyph(servedValue));
          expect(Number(value.getAttribute("data-bridge-value"))).toBe(servedValue);

          const row = container.querySelector<HTMLElement>('[data-recon-line="net_provisions"]')!;
          const accounts = row.querySelector<HTMLElement>('[data-recon-accounts="net_provisions"]')?.textContent ?? "";
          const figure = row.querySelector<HTMLElement>(".text-right")?.textContent ?? "";
          expect(accounts, `${lang}: the chain row states the effect's arithmetic`).toBe("7812 + 7814 − 6812 − 6814");
          expect(readBack(figure), `${lang}: the chain row prints the effect`).toBeCloseTo(-servedValue, 2);
          expect(evaluate(accounts, npBlock), `${lang}: "${accounts}" evaluates to the printed ${figure}`)
            .toBeCloseTo(readBack(figure), 2);
          cleanup();
        }
      } finally {
        await i18n.changeLanguage("en");
        cleanup();
      }
    });

    it(`${name}: the printed P&L (report + workbook) — the row's arithmetic is its figure, the bridge after EBITDA the P&L tab's charge`, () => {
      const pair = make();
      const apl = pair.current_body.statements.assembled_pl as unknown as Rec;
      const npBlock = apl.net_provisions as Rec;
      const servedValue = npBlock.value as number;
      const ppl = printedPl(pair.current_body.statements);
      const row = ppl.rows.find((r) => r.key === "net_provisions")!;
      expect(row, "the printed P&L carries the net-provisions row").toBeDefined();
      const m = /\(([^()]*)\)\s*$/.exec(row.label);
      expect(m, `the row names its accounts: ${row.label}`).not.toBeNull();
      expect(row.label.startsWith(npBlock.name_en as string), row.label).toBe(true);
      expect(row.value).toBeCloseTo(-servedValue, 2);
      expect(evaluate(m![1], npBlock), `"${m![1]}" evaluates to the printed ${row.value}`).toBeCloseTo(row.value as number, 2);
      // The one-line bridge: after EBITDA, the charge as the P&L tab prints it.
      const level = `${servedValue < 0 ? MINUS : ""}${Math.round(Math.abs(servedValue)).toLocaleString("en-US")}`;
      const segment = (ppl.bridge ?? "").split(" · ").find((x) => x.includes(npBlock.label_en as string)) ?? "";
      expect(segment, `the bridge carries net provisions after EBITDA: ${ppl.bridge}`).not.toBe("");
      expect(segment.endsWith(` ${level}`), `"${segment}" ends on the P&L tab's charge ${level}`).toBe(true);
      expect(segment.startsWith("+ "), `"${segment}" carries no effect sign`).toBe(false);
    });
  }
});
