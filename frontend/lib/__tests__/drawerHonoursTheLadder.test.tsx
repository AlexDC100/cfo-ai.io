// G-S6/S7 — THE DRAWER IS A SURFACE OF THE SAME DOCUMENT.
//
// `RatioDetailDrawer` is one click from every ratio card. It renders from
// `ratioKnowledge.ts` — a hand-written education map — beside a value and
// a badge that came from `computeRatios`. Two things had drifted apart
// there, both measured on the committed books.
//
// ── §1. THE SECTOR REFUSAL WAS HONOURED IN THE EXPORT AND LEAKED HERE ─
//
//     {ratio.ladder ? ladderSentence(...) : knowledge.goodRange}
//
// The fallback fires exactly when the ladder was WITHHELD. On the owner's
// live configuration — the Agras meat book served as "Real estate ·
// residential rental" — the printed export says
//
//     Benchmark withheld — this ratio's healthy range differs by sector
//     and the sector is unconfirmed
//
// and the drawer, one click away, said "≥ 15% healthy · ≥ 25% strong".
// Seven rows on that configuration: ebitda_margin, dio, net_margin,
// gross_margin, dso, asset_turnover, adjusted_dscr. The withheld cutoff
// and the leaked one are the SAME cutoff, so the refusal bought nothing.
//
// ── §2. THE EXPLANATION DESCRIBED A DIFFERENT ARITHMETIC ─────────────
//
// Six entries contradicted what `computeRatios` computes, on the book
// the drawer was open over:
//
//   cash_ratio         "Cash & equivalents ÷ Current liabilities" — the
//                      card says cash EXCLUDES short-term investments
//                      (class 50), which is the whole reason agras reads
//                      0.09× CRITICAL instead of 0.159× WATCH. And this
//                      is a `formulaParts` entry, so the drawer rendered
//                      it as the live-numbers breakdown.
//   interest_coverage  "EBIT ÷ Interest expense" — the card's own text
//                      is "EBITDA (statutory) ÷ interest expense — NOT
//                      EBIT ÷ interest". On retail those two bases
//                      differ in SIGN: +0.09× against −0.52×.
//   dio, dpo           "(… ÷ COGS) × 365" — the card divides by TOTAL
//                      operating expense and says "not narrow COGS".
//                      31.5 d against 46.2 d on agras.
//   roe                "Average equity" — closing equity is used.
//   asset_turnover     "Average total assets" — closing is used.
//
// ── WHAT THIS REDS ON, AFTER THE REPAIR (TC-11) ──────────────────────
//
// §1a a drawer opened on a row whose ladder was WITHHELD printing any
//     cutoff at all, from any source
// §1b that same drawer failing to print the refusal sentence the export
//     prints for the same row
// §2a a knowledge formula naming a basis the ratio's own formula
//     explicitly NEGATES ("NOT EBIT ÷ interest", "not narrow COGS")
// §2b a knowledge formula claiming an AVERAGE where the product uses a
//     closing figure
// §2c a knowledge formula implying the inclusion of something the card
//     says is excluded — today one pair: "cash equivalents" against a
//     cash figure that leaves short-term investments out
// §2d a `formulaParts` source hint carrying the same contradiction; the
//     hint is what the reader sees when they tap the number
//
// ── WHAT IT CANNOT SEE ───────────────────────────────────────────────
//
// * Whether the education copy is GOOD. It holds prose to the arithmetic
//   beside it; it has no opinion about clarity.
// * A contradiction expressed in words neither list names. §2 is a
//   vocabulary check, not a parser — the vocabulary is the six bases
//   that actually collided, and a seventh would need adding here.
// * The `roic` and `dscr_with_lt_principal` rows, which have NO knowledge
//   entry at all; the drawer falls back to `FallbackBody`, which prints
//   `ratio.benchmark` and nothing hand-written. Named, not covered.

import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/renderWithProviders";
import { RatioDetailDrawer } from "@/components/cfo/RatioDetailDrawer";
import { RATIO_KNOWLEDGE, getRatioKnowledge } from "@/lib/ratioKnowledge";
import { computeRatios, SECTOR_BAND_WITHHELD, type Ratio, type RatioBundle } from "@/lib/financialReport";
import { BOOKS, type Book, agreeingBook, disputedBook, metricsFor } from "./exportBooks";

function bundleFor(s: ReturnType<typeof agreeingBook>, book: Book): RatioBundle {
  return computeRatios(s, undefined, metricsFor(book));
}

function flat(r: RatioBundle): Ratio[] {
  return [r.liquidity, r.profitability, r.leverage, r.coverage, r.efficiency].flat();
}

// ══════════════════════════════════════════════════════════════════════
// §1 — a withheld ladder stays withheld one click deeper
// ══════════════════════════════════════════════════════════════════════

describe("§1 the drawer honours the sector refusal", () => {
  it.each(BOOKS)("%s: the disputed book withholds, and the drawer withholds too", (book: Book) => {
    const s = disputedBook(book);
    const bundle = bundleFor(s, book);
    const withheld = flat(bundle).filter((r) => r.verdict === "ungraded");
    expect(
      withheld.length,
      `${book}: served under the industry its own account mix disputes, nothing was ` +
        `withheld. The whole §1 case is unreachable — either the dispute fixture stopped ` +
        `disputing or the sector-calibrated set emptied.`,
    ).toBeGreaterThan(0);
    // Both withholdings appear on the four books and both must hold:
    // the sector one (`SECTOR_BAND_WITHHELD`) and the scale one — on
    // realestate `debt_to_ebitda` is ungraded because EBITDA is
    // RON −29.04M and every rung would read backwards through a negative
    // divisor. The assertion is therefore "the row's OWN reason is
    // printed", not a fixed sentence.
    let sawSectorWithholding = false;
    for (const ratio of withheld) {
      const knowledge = getRatioKnowledge(ratio);
      if (ratio.benchmark === SECTOR_BAND_WITHHELD) sawSectorWithholding = true;
      const { container, unmount } = renderWithProviders(
        <RatioDetailDrawer
          ratio={ratio}
          bundle={bundle}
          statements={s}
          onClose={() => {}}
          onPickRelated={() => {}}
        />,
      );
      const text = (container.ownerDocument.body.textContent ?? "").replace(/\s+/g, " ");
      expect(
        text,
        `${book}/${ratio.key}: the export prints "${ratio.benchmark}" for this row and ` +
          `the drawer does not say so at all.`,
      ).toContain(ratio.benchmark);
      if (knowledge) {
        expect(
          text.includes(knowledge.goodRange),
          `${book}/${ratio.key}: the ladder was WITHHELD ("${ratio.benchmark}"), and the ` +
            `drawer printed "${knowledge.goodRange}" anyway — the same cutoff the export ` +
            `refused, in a different file. The refusal has to hold on every surface or it ` +
            `holds on none.`,
        ).toBe(false);
      }
      unmount();
    }
    expect(
      sawSectorWithholding,
      `${book}: no row was withheld for the SECTOR reason, so the owner's own case — a ` +
        `book served under an industry its accounts dispute — is not exercised here.`,
    ).toBe(true);
  });

  it("agras, graded: the drawer still prints the ladder it WAS banded on", () => {
    // The other half — the refusal must not have become a blanket
    // silence. A row that IS graded shows its rungs.
    const s = agreeingBook("agras");
    const bundle = bundleFor(s, "agras");
    const ratio = flat(bundle).find((r) => r.key === "current_ratio");
    expect(ratio?.verdict).not.toBe("ungraded");
    const { container, unmount } = renderWithProviders(
      <RatioDetailDrawer
        ratio={ratio as Ratio}
        bundle={bundle}
        statements={s}
        onClose={() => {}}
        onPickRelated={() => {}}
      />,
    );
    expect(screen.getByText(/What good looks like/)).toBeTruthy();
    const text = (container.ownerDocument.body.textContent ?? "").replace(/\s+/g, " ");
    expect(text).not.toContain("Benchmark withheld");
    expect(text).toMatch(/1\.5/);
    unmount();
  });
});

// ══════════════════════════════════════════════════════════════════════
// §2 — the explanation describes the arithmetic beside it
// ══════════════════════════════════════════════════════════════════════

/** A basis the CARD says is not used. The left side is the phrase that
 *  appears in `Ratio.formula` when the product is disclaiming something;
 *  the right side is what must therefore be absent from the knowledge
 *  entry for that same row. */
const NEGATIONS: Array<{ cardSays: RegExp; knowledgeMustNotSay: RegExp; why: string }> = [
  {
    cardSays: /NOT EBIT ÷ interest/i,
    knowledgeMustNotSay: /\bEBIT ÷/i,
    why: "the card's own text negates EBIT ÷ interest by name",
  },
  {
    cardSays: /not narrow COGS/i,
    knowledgeMustNotSay: /÷ COGS|÷ Cost of goods|COGS\) ×/i,
    why: "the card divides by TOTAL operating expense and says so",
  },
  {
    cardSays: /excludes short-term investments/i,
    knowledgeMustNotSay: /equivalent/i,
    why:
      "\"cash equivalents\" conventionally INCLUDES short-term investments, which is " +
      "exactly what this figure leaves out — on agras that is RON 906,526 and the " +
      "difference between CRITICAL and WATCH",
  },
];

describe("§2 ratioKnowledge cannot contradict what was computed", () => {
  it.each(BOOKS)("%s: no knowledge entry states a basis the card negates", (book: Book) => {
    const s = agreeingBook(book);
    for (const ratio of flat(bundleFor(s, book))) {
      const k = getRatioKnowledge(ratio);
      if (!k) continue;
      for (const rule of NEGATIONS) {
        if (!rule.cardSays.test(ratio.formula)) continue;
        // An entry is allowed to REPEAT the disclaimer — "EBITDA ÷
        // interest — NOT EBIT ÷ interest" states the right basis and
        // names the wrong one so the reader can tell them apart. Strip
        // the negation clause first; what is left is the affirmative
        // claim, and that is what may not carry the negated basis.
        const affirmative = (s: string): string => s.replace(rule.cardSays, "");
        expect(
          rule.knowledgeMustNotSay.test(affirmative(k.formula)),
          `${book}/${ratio.key}: the card states\n      "${ratio.formula}"\n` +
            `  and ratioKnowledge states\n      "${k.formula}"\n` +
            `  — ${rule.why}. The drawer prints both, inches apart, over one number.`,
        ).toBe(false);
        for (const part of k.formulaParts ?? []) {
          if (part.kind !== "value") continue;
          expect(
            rule.knowledgeMustNotSay.test(affirmative(part.source.hint ?? "")),
            `${book}/${ratio.key}: the tap-through hint for "${part.label}" reads ` +
              `"${part.source.hint}" — ${rule.why}.`,
          ).toBe(false);
        }
      }
    }
  });

  it.each(BOOKS)("%s: no knowledge entry claims an average the product does not take", (book: Book) => {
    const s = agreeingBook(book);
    for (const ratio of flat(bundleFor(s, book))) {
      const k = getRatioKnowledge(ratio);
      if (!k) continue;
      if (!/average/i.test(k.formula)) continue;
      expect(
        /average/i.test(ratio.formula),
        `${book}/${ratio.key}: ratioKnowledge states "${k.formula}" while the product ` +
          `computes "${ratio.formula}" — a closing figure, because one trial balance ` +
          `carries one period and there is no opening balance sheet to average against. ` +
          `A reader recomputing on the average gets a different number and no way to know why.`,
      ).toBe(true);
    }
  });

  it("every knowledge entry belongs to a ratio some book actually renders", () => {
    // A knowledge key with no ratio behind it is prose nobody can check
    // against arithmetic — the state the six contradictions above grew in.
    const rendered = new Set<string>();
    for (const book of BOOKS) {
      for (const r of flat(bundleFor(agreeingBook(book), book))) rendered.add(r.key);
    }
    const orphans = Object.keys(RATIO_KNOWLEDGE).filter((k) => !rendered.has(k));
    expect(
      orphans,
      `ratioKnowledge carries entries for ratios no book renders: ${orphans.join(", ")}. ` +
        `Nothing holds their prose to an arithmetic.`,
    ).toEqual(["altman_z"]);
  });
});
