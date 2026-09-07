// G3 — THE PRINTED P&L IS A COLUMN A READER CAN ADD UP.
//
// Every subtotal the printed report states equals the sum of the lines
// above it since the previous subtotal, and every line contributes to
// exactly one subtotal. Read over the RENDERED document (TC-7), parsed
// back out of the bytes `buildReportHtml` writes to disk, because the
// defect this gate exists for was invisible in the served data: the
// engine's `assembled_pl` foots to the cent on all four books, and the
// document that printed it did not.
//
// MEASURED ON THE CURRENT TREE BEFORE THE REPAIR (2026-09-07), from
// `tests/engine/fixtures/firm/saga_10_col_*.json`:
//
//   book         subtotal            printed          lines above it     gap
//   agras        Profit Before Tax   15,577,652       15,187,215      +390,437
//   agras        Net Income           7,533,676       14,106,102    −6,572,426
//   carniprod    Profit Before Tax    6,131,135        5,893,219      +237,916
//   carniprod    Net Income           1,435,534        5,843,449    −4,407,915
//   realestate   Profit Before Tax  −30,391,418      −30,258,931      −132,487
//   realestate   Net Income            −801,604      −30,391,418   +29,589,814
//   retail       Profit Before Tax    1,161,958       −3,675,861    +4,837,819
//   retail       Net Income           3,205,213        1,161,958    +2,043,255
//
// TWO DISTINCT CAUSES, and the owner's report named only one of them:
//
//   1. The financial block. The table stepped EBIT → PBT through INTEREST
//      EXPENSE ALONE, dropping financial income and the non-interest
//      financial expense the same envelope carries. On agras the residual
//      it produced (390,437.49) lands 346.94 RON from other operating
//      income (390,090.55) — near enough that the document reads as if
//      other income were counted twice. IT IS NOT: EBIT + net financial
//      result = 15,465,144.89 + 112,507.14 = 15,577,652.03 = pretax,
//      exactly, and other operating income sits inside EBITDA once. The
//      two quantities are different and their closeness is a coincidence.
//      The repair is to PRINT the arithmetic, not to move a figure.
//
//   2. The bridge to account 121. `pretax − tax` is the class-6/7
//      RECONSTRUCTION (`net_income_operational`); the row the table ends
//      on is the FILED figure (`net_income_statutory`, account 121). The
//      reconciling amount was never missing — `assembled_pl
//      .net_income_reconciliation_to_121` carries it on every book — the
//      RENDER omitted the row.
//
// WHAT IT REDS ON, after the repair (TC-11): any new line added to the
// printed P&L without a subtotal absorbing it, any subtotal re-sourced to
// a field that is not the sum of its own steps (retail's `operating_ebit`
// vs `ebit` differ by discounts received, 1,923.78 — sourcing the EBIT row
// from the former reds this gate), and the reconciliation row disappearing
// again on any book where the gap is non-zero.
//
// WHAT IT CANNOT SEE: whether the individual line VALUES are right — a
// column of wrong numbers that happens to add up passes here (the anchor
// gate `tests/engine/test_rebuild_net_income_anchor.py` is that half). It
// reads the P&L table only; the balance sheet's totals-of-subtotals shape
// is a different structure and is not asserted here.

import { describe, expect, it } from "vitest";

import { BOOKS, type Book, exportDoc, parsePrinted, plRows, statementsFor } from "./exportBooks";

/** A printed row is a SUBTOTAL when the document says so in its class. */
const isSubtotal = (cls: string) => /\b(subtotal|total)\b/.test(cls);
/** A MEMO stands beside the column and is never added into it. */
const isMemo = (cls: string) => /\bmemo\b/.test(cls);

interface Span {
  subtotal: string;
  printed: number;
  steps: Array<{ label: string; value: number }>;
  opening: number;
}

/** Walk the printed rows into one span per subtotal. */
function spansOf(book: Book): { spans: Span[]; stepCount: number; assigned: number } {
  const rows = plRows(exportDoc(book));
  const spans: Span[] = [];
  let running = 0;
  let pending: Array<{ label: string; value: number }> = [];
  let opening = 0;
  let stepCount = 0;
  let assigned = 0;
  for (const row of rows) {
    if (isMemo(row.cls)) continue;
    const v = parsePrinted(row.printed);
    if (v === null) continue;
    if (isSubtotal(row.cls)) {
      spans.push({ subtotal: row.label, printed: v, steps: pending, opening });
      assigned += pending.length;
      pending = [];
      running = v;
      opening = v;
      continue;
    }
    stepCount += 1;
    pending.push({ label: row.label, value: v });
    running += v;
  }
  void running;
  return { spans, stepCount, assigned };
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

describe("G3 — the printed P&L foots, subtotal by subtotal", () => {
  for (const book of BOOKS) {
    it(`${book}: every subtotal equals the lines above it`, () => {
      const { spans } = spansOf(book as Book);
      expect(spans.length, `${book}: the printed P&L states no subtotal at all`).toBeGreaterThan(3);
      const failures: string[] = [];
      for (const span of spans) {
        const sum = span.steps.reduce((a, s) => a + s.value, span.opening);
        // Every printed figure is rounded to whole units by `money()`, so
        // one display step of slack per printed row is a rounding, not a
        // disagreement. Anything wider is a missing or double-counted line.
        const tolerance = 0.5 * (span.steps.length + 2);
        if (Math.abs(sum - span.printed) > tolerance) {
          failures.push(
            `${book}: subtotal “${span.subtotal}” prints ${fmt(span.printed)} but the ` +
              `${span.steps.length} line(s) above it sum to ${fmt(sum)} — off by ` +
              `${fmt(span.printed - sum)}` +
              (span.steps.length
                ? ` (lines: ${span.steps.map((s) => `${s.label} ${fmt(s.value)}`).join("; ")})`
                : " (no line at all between this subtotal and the previous one)"),
          );
        }
      }
      expect(failures, `${book}: the printed P&L does not foot`).toEqual([]);
    });

    it(`${book}: no printed line contributes to two subtotals`, () => {
      const { stepCount, assigned, spans } = spansOf(book as Book);
      // Structural, not arithmetic: the walk assigns each step row to the
      // NEXT subtotal and to no other, so a step counted twice or dropped
      // shows up as a count mismatch. A trailing step with no subtotal
      // after it is also caught here — it would be assigned to nothing.
      expect(
        assigned,
        `${book}: ${stepCount} step row(s) printed, ${assigned} assigned to a subtotal — ` +
          `a line that belongs to no subtotal, or to two`,
      ).toBe(stepCount);
      const labels = spans.flatMap((s) => s.steps.map((x) => x.label));
      expect(new Set(labels).size, `${book}: a step label appears twice in the column`).toBe(
        labels.length,
      );
    });

    it(`${book}: the bridge from the reconstruction to account 121 is a labelled row`, () => {
      const pl = statementsFor(book as Book).assembled_pl ?? {};
      const gap = pl.net_income_reconciliation_to_121;
      if (typeof gap !== "number" || Math.abs(gap) <= 0.005) return; // nothing to bridge
      const rows = plRows(exportDoc(book as Book));
      const bridge = rows.find((r) => /account 121|reconcil/i.test(r.label));
      expect(
        bridge,
        `${book}: the reconstruction and the filed figure differ by ${fmt(gap)} and the ` +
          `printed P&L states no row for it — the amount is served as ` +
          `assembled_pl.net_income_reconciliation_to_121, so the number is not missing, ` +
          `the line is`,
      ).toBeTruthy();
      const printed = parsePrinted(bridge!.printed);
      expect(
        printed,
        `${book}: the bridge row “${bridge!.label}” prints ${JSON.stringify(bridge!.printed)}`,
      ).not.toBeNull();
      expect(Math.abs((printed ?? 0) - gap), `${book}: the bridge row states the wrong amount`)
        .toBeLessThanOrEqual(1);
    });
  }
});
