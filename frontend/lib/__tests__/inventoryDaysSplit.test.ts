// INVENTORY DAYS — THE SPLIT AS EVERY SURFACE PRINTS IT (owner spec
// 2026-09-26 P1, design B4).
//
// `printInventoryDays` is the one printed form of the served block: the
// Ratios tile and drawer, the CFO report (screen, PDF, workbook) and the
// cockpit's bank export all print it. These laws hold it to the block:
//   · every figure it prints is the block's quantized `value_q`, in the
//     reader's language (RO decimal comma, the ratio table's count forms);
//   · all four lines are printed — three legs with their accounts and
//     "alte stocuri" with the accounts the book carries, inside the total;
//   · a refused leg or total prints the ENGINE's reason, never a number;
//   · the basis sentence is the block's own; an average basis also prints
//     the period-end figure the cycle uses; a snapshot prints why;
//   · a book with no block refuses — there is no fallback arithmetic.
//
// Fixtures: the corpus books (fixtures/coverage_popover_corpus.json, kept
// fresh by tests/engine/test_coverage_popover_corpus_fixture.py) and the
// constructed one-EBITDA books. No client book is copied here.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  inventoryDaysDocHtml,
  inventoryDaysSheetRows,
  printDaysQ,
  printInventoryDays,
  readInventoryDaysSplit,
} from "@/lib/inventoryDays";

type Json = Record<string, unknown>;
const load = (name: string): Json => JSON.parse(readFileSync(resolve(__dirname, "fixtures", name), "utf-8"));
const corpus = load("coverage_popover_corpus.json") as { books: { case: string; body?: { statements: Json } }[] };
const constructed = load("oneEbitda/constructed_books.json") as Record<string, { statements: Json }>;

const book = (name: string): Json => {
  const b = corpus.books.find((x) => x.case === name);
  if (!b?.body) throw new Error(`corpus book ${name} is not served`);
  return b.body.statements;
};
const blockOf = (s: Json): Json => s.inventory_days as Json;

describe("readInventoryDaysSplit + printInventoryDays", () => {
  it("prints the three legs, alte stocuri and the total from the block's own value_q (RO)", () => {
    const s = book("saga_10_col_agras");
    const block = blockOf(s);
    const split = readInventoryDaysSplit(s)!;
    expect(split).not.toBeNull();
    const p = printInventoryDays(split, "ro");
    const groups = block.groups as Json[];
    expect(p.legs.map((l) => l.key)).toEqual(groups.map((g) => g.key));
    groups.forEach((g, i) => {
      const q = g.value_q as string;
      expect(p.legs[i].days).toBe(printDaysQ(q, "ro"));
      expect(p.legs[i].days).toContain(q.replace(".", ","));
      expect(p.legs[i].label).toBe(g.label_ro);
      for (const code of g.stock_accounts as string[]) expect(p.legs[i].accounts).toContain(code);
    });
    const total = block.total as Json;
    expect(p.total.days).toBe(printDaysQ(total.value_q as string, "ro"));
    expect(p.total.label).toBe(total.label_ro);
    // alte stocuri: the synthetic accounts the book carries, inside the total
    expect(p.other).not.toBeNull();
    expect(p.other!.accounts).toContain("381");
    expect(p.other!.days).toBe("inclus în total, fără zile proprii");
    // the basis is the block's own sentence, and the period-end figure the
    // cycle adds is printed beside the average
    expect(p.basis).toBe(`Bază: ${(block.basis_label as Json).ro}`);
    expect(p.closing).toContain(printDaysQ(total.closing_value_q as string, "ro"));
  });

  it("prints English from the same block", () => {
    const s = book("saga_10_col_agras");
    const p = printInventoryDays(readInventoryDaysSplit(s)!, "en");
    const total = blockOf(s).total as Json;
    expect(p.title).toBe("Inventory days — split by stock type");
    expect(p.total.days).toBe(printDaysQ(total.value_q as string, "en"));
    expect(p.total.days).toContain(total.value_q as string);
    expect(p.legs[0].flow).toBe("÷ Materials consumed (601 + 602 + 603)");
  });

  it("a leg with no stock prints the engine's reason, not a figure", () => {
    const s = book("saga_10_col");
    const block = blockOf(s);
    const merch = (block.groups as Json[]).find((g) => g.key === "merchandise")!;
    expect(merch.value_q).toBeNull();
    const p = printInventoryDays(readInventoryDaysSplit(s)!, "ro");
    const leg = p.legs.find((l) => l.key === "merchandise")!;
    expect(leg.refused).toBe(true);
    expect(leg.days).toBe(`necalculat — ${(merch.reason as Json).text_ro}`);
    expect(leg.days).not.toMatch(/\d/);
    // alte stocuri names what the book holds (321, 346, 351, 381)
    expect(p.other!.accounts).toBe("conturile 321, 346, 351, 381");
  });

  it("a refused total prints its reason and no period-end figure", () => {
    const s = book("saga_10_col_realestate");
    const block = blockOf(s);
    const p = printInventoryDays(readInventoryDaysSplit(s)!, "en");
    expect(p.total.refused).toBe(true);
    expect(p.total.days).toBe(`not computed — ${((block.total as Json).reason as Json).text_en}`);
    expect(p.closing).toBeNull();
    for (const leg of p.legs) expect(leg.refused).toBe(true);
  });

  it("a year-end snapshot is labelled as one day and says why", () => {
    const s = constructed.closed_bridge.statements;
    const block = blockOf(s);
    expect(block.basis).toBe("year_end_snapshot");
    const split = readInventoryDaysSplit(s)!;
    expect(split.isAverage).toBe(false);
    const p = printInventoryDays(split, "ro");
    expect(p.basis).toBe(`Bază: ${(block.basis_label as Json).ro}`);
    expect(p.basis).toContain("o singură zi");
    expect(p.closing).toBeNull();
    const why = ((block.opening as Json).reason as Json).text_ro as string;
    expect(p.notes).toContain(`Un singur sold: ${why}`);
  });

  it("a seasonal book carries the engine's seasonality note once", () => {
    const s = book("saga_10_col_agras");
    const block = JSON.parse(JSON.stringify(blockOf(s))) as Json;
    block.seasonality = { flagged: true, note_ro: "notă sezon", note_en: "season note" };
    const split = readInventoryDaysSplit({ inventory_days: block })!;
    expect(split.seasonalNote).toEqual({ ro: "notă sezon", en: "season note" });
    const p = printInventoryDays(split, "ro");
    expect(p.notes.filter((n) => n.includes("notă sezon"))).toEqual(["Sezonalitate: notă sezon"]);
  });

  it("no block, no split — never a fallback", () => {
    expect(readInventoryDaysSplit({})).toBeNull();
    expect(readInventoryDaysSplit(null)).toBeNull();
    expect(readInventoryDaysSplit({ inventory_days: { schema: "other/1" } })).toBeNull();
  });

  it("the document block and the workbook rows carry the same printed lines", () => {
    const p = printInventoryDays(readInventoryDaysSplit(book("saga_10_col_agras"))!, "en");
    const html = inventoryDaysDocHtml(p);
    const rows = inventoryDaysSheetRows(p);
    for (const r of [...p.legs, p.other!, p.total]) {
      expect(html).toContain(`data-inventory-leg="${r.key}"`);
      expect(html).toContain(r.days);
      expect(rows.some((row) => row[0] === r.label && row[2] === r.days)).toBe(true);
    }
    expect(html).toContain(p.basis);
    expect(rows.some((row) => row[0] === p.basis)).toBe(true);
    expect(html).toContain(p.closing!);
  });
});
