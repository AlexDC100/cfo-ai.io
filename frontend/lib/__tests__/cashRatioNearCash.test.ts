// D4 — THE CAPTION SENT THE READER TO THE WRONG ROW.
//
// ── WHAT WAS MEASURED, ON THE agras EXPORT, 2026-09-07 ──────────────
//
// The Cash Ratio prose block closed with
//
//     "…Counting short-term investments as well would raise this
//      reading; the balance sheet's other current assets show how much
//      is at stake."
//
// On agras "other current assets" is RON 8,861,293 while the near-cash
// the sentence MEANS — short-term investments, RAS class 50 — is RON
// 906,526. A reader who followed the pointer and re-ran the arithmetic
// got (1,168,047 + 8,861,293) ÷ 13,012,977 = 0.77×, nine times the
// 0.159× the sentence was about, and two whole bands past it. A caption
// that names a figure and names the wrong one is worse than silence,
// because the reader does the sum and then trusts the answer.
//
// The served canonical balance sheet carries the right row by name —
// `short_term_investments`, account_codes ['50'] — so the caption states
// THAT amount where the envelope carries it, and states an unknown where
// it does not. Never a substitute.
//
// ── WHAT THIS GATE REDS ON, AFTER THE REPAIR (TC-11) ────────────────
//
//   · the Cash Ratio prose pointing a reader at "other current assets"
//     (or at any figure that is not the class-50 row) on any book;
//   · a book whose served balance sheet DOES carry the class-50 row and
//     whose caption does not state that amount;
//   · a book whose served balance sheet does NOT carry it and whose
//     caption states an amount anyway.
//
// ── WHAT IT CANNOT SEE ──────────────────────────────────────────────
//
//   · whether EXCLUDING class 50 from the cash ratio is the right
//     methodology. It is not: it is a choice, defensible either way, and
//     the whole point of the N3 repair before this one was to STATE it.
//     This gate only holds the statement honest.
//   · the committed `saga_10_col_*.json` statements half carries no
//     `canonical_bs` at all (the capture predates the serve-path
//     override at `pipeline.py:4999`), so the "carries the row" half is
//     measured through `withCanonicalBs`, which joins the SAME fixture
//     file's `envelope.canonical_bs` — the object the gateway serves.

import { describe, expect, it } from "vitest";

import { buildReportHtml } from "@/lib/financialExports";
import {
  BOOKS,
  exportDoc,
  metricsFor,
  proseBlocks,
  statementsFor,
  withCanonicalBs,
  type Book,
} from "./exportBooks";

function cashRatioProse(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const found = proseBlocks(doc).find((t) => t.startsWith("Cash Ratio:"));
  return found ?? "";
}

function servedShortTermInvestments(book: Book): number | null {
  const s = withCanonicalBs(book) as { canonical_bs?: { rows: Array<{ id: string; amount: number }> } };
  const row = s.canonical_bs?.rows.find((r) => r.id === "short_term_investments");
  return row === undefined ? null : row.amount;
}

const OTHER_CURRENT_ASSETS = /other current assets/i;

describe("D4 — the Cash Ratio caption names the near-cash it means", () => {
  for (const book of BOOKS) {
    it(`${book}: the caption never points at other current assets`, () => {
      for (const [label, html] of [
        ["as captured", buildReportHtml(statementsFor(book), { metricsByName: metricsFor(book) })],
        [
          "with the served balance sheet",
          buildReportHtml(withCanonicalBs(book), { metricsByName: metricsFor(book) }),
        ],
      ] as const) {
        const prose = cashRatioProse(html);
        if (prose === "") continue; // the row does not band low on this book
        expect(
          OTHER_CURRENT_ASSETS.test(prose),
          `${book} (${label}): the Cash Ratio caption sends the reader to "other current ` +
            `assets" (RON ${statementsFor(book).balanceSheet.otherCurrentAssets.toLocaleString(
              "en-US",
            )}) for a figure that is the class-50 balance (RON ${
              servedShortTermInvestments(book)?.toLocaleString("en-US") ?? "not served"
            }). Caption: "${prose}"`,
        ).toBe(false);
      }
    });
  }

  for (const book of BOOKS) {
    it(`${book}: it states the class-50 balance iff the served balance sheet carries it`, () => {
      const prose = cashRatioProse(
        buildReportHtml(withCanonicalBs(book), { metricsByName: metricsFor(book) }),
      );
      if (prose === "") return;
      const sti = servedShortTermInvestments(book);
      if (sti === null) {
        expect(
          /RON\s[\d.,]+\s?[KMB]?\s+of them/.test(prose),
          `${book}: the served balance sheet carries no short-term-investments row and the ` +
            `caption states an amount anyway: "${prose}"`,
        ).toBe(false);
        expect(prose).toContain("does not carry that balance as its own line");
      } else {
        expect(
          prose,
          `${book}: the served balance sheet carries RON ${sti.toLocaleString(
            "en-US",
          )} of short-term investments and the caption does not state it: "${prose}"`,
        ).toMatch(/RON\s[\d.,]+\s?[KMB]?\s+of them \(RAS class 50\)/);
        // The stated figure must BE that balance, within the compaction
        // the rest of the document uses for money inside a sentence.
        const printed = /RON\s([\d.,]+\s?[KMB]?)\s+of them/.exec(prose)?.[1] ?? "";
        const unit = /[KMB]/.test(printed)
          ? printed.includes("B")
            ? 1e9
            : printed.includes("M")
              ? 1e6
              : 1e3
          : 1;
        const value = Number(printed.replace(/[^\d.]/g, "")) * unit;
        expect(
          Math.abs(value - sti) <= unit / 2,
          `${book}: the caption states ${printed} where the served row is ${sti.toLocaleString(
            "en-US",
          )}`,
        ).toBe(true);
      }
    });
  }

  it("NON-VACUITY — at least one committed book really serves the class-50 row", () => {
    const carriers = BOOKS.filter((b) => servedShortTermInvestments(b) !== null);
    expect(
      carriers.join(", "),
      "no committed book carries a short_term_investments row, so the 'states it' half of " +
        "this gate proves nothing",
    ).not.toBe("");
  });

  it("agras: the figures behind the defect are still what the header claims", () => {
    // The gate's own premise, measured — so a fixture change that moves
    // these numbers reds here rather than quietly making the comment
    // above false.
    const s = statementsFor("agras");
    expect(s.balanceSheet.otherCurrentAssets).toBeCloseTo(8_861_292.52, 2);
    expect(servedShortTermInvestments("agras")).toBeCloseTo(906_526.42, 2);
    // And the export still bands this row low enough to print the prose.
    expect(cashRatioProse(exportDoc("agras").documentElement.outerHTML)).not.toBe("");
  });
});
