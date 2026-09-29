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
// REDS ON: an effect sign ("+" on a release, "−" on a charge) or a colour on
// the current cell; a prior or Δ cell off the engine's column.
// CANNOT SEE: whether the served figures are right (provisions-symmetric);
// the printed report / workbook (effect-signed on every row, current and
// prior alike — printedPl); pixels.
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
  }
});
