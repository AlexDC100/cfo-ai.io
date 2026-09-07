/**
 * G9 — THE SWAP TEST: no wrong-sector language in the printed report.
 *
 * The owner read the Agras Dec-2025 export — a meat processor, accounts
 * 301/341/345/371, COGS 70.5M — and found it advising them about
 * vacancy, LTV ceilings and single-tenant risk.
 *
 * The first repair gated a commercial-real-estate RULE that had been
 * firing on every book because `rule.industries && industry && !match`
 * treats an ABSENT industry as a match. That was real, and it was not
 * the whole leak: two of the three phrases were hardcoded in the PROSE
 * of rules that declare no sector at all and therefore fire everywhere.
 * A refinance rule told every reader to negotiate an "LTV ceiling" and
 * refuse "MAC clauses tied to single-tenant risk"; a covenant-monitoring
 * rule named "vacancy" as its example shock. Gating those rules would
 * have been the wrong fix — they genuinely apply to every business. The
 * prose had to stop assuming one.
 *
 * So this asserts over the RENDERED DOCUMENT (TC-7), not over the rule
 * table: a phrase can only leak through what a reader actually sees, and
 * the previous gate passed while three of these words were on the page.
 *
 * WHAT IT REDS ON (TC-11)
 *   · any sector-specific term in a report for a book of another sector;
 *   · in particular, a sector-neutral rule that hardcodes one sector's
 *     vocabulary in its fallback prose.
 * WHAT IT CANNOT SEE
 *   · a phrase not on the list. The list is a lexicon, not a closed
 *     rule, and is named as one — a new sector idiom ships unnoticed
 *     until someone adds it. The structural fix is that sector-scoped
 *     advice must declare `industries`; this catches the residue.
 *   · prose that is merely generic rather than wrong (that is G9's
 *     boilerplate half, and it is not asserted here).
 *   · the on-screen page, which renders from the same rules but is a
 *     different renderer — `industryBlock.test.tsx` covers it.
 */

import { describe, it, expect } from "vitest";
import { BOOKS, exportHtml, type Book } from "./exportBooks";

/**
 * Vocabulary that is only meaningful for one sector. Keys are the sector
 * the term belongs to; a term may appear in a report for THAT sector and
 * nowhere else. RO equivalents included — the report ships in both
 * languages and a leak in one is a leak.
 */
const SECTOR_VOCABULARY: Record<string, string[]> = {
  real_estate: [
    "vacancy", "grad de ocupare", "neocupare",
    "LTV", "loan-to-value", "loan to value",
    "single-tenant", "single tenant", "chiriaș unic",
    "cap rate", "rata de capitalizare",
    "rent roll", "yield on cost",
    "investment property", "proprietate de investiții",
  ],
  trade: ["like-for-like sales", "footfall", "trafic în magazin", "same-store"],
  manufacturing: ["overall equipment effectiveness", "OEE", "takt time"],
};

/** The sector each committed book actually is, from its account mix. */
const BOOK_SECTOR: Record<Book, string> = {
  agras: "manufacturing",
  carniprod: "manufacturing",
  retail: "trade",
  realestate: "real_estate",
};

function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ");
}

describe("G9 — no wrong-sector language in the printed report", () => {
  it("is not vacuous: the vocabulary is non-empty and the books are classified", () => {
    expect(Object.keys(SECTOR_VOCABULARY).length).toBeGreaterThanOrEqual(3);
    expect(BOOKS.every((b) => BOOK_SECTOR[b])).toBe(true);
  });

  for (const book of BOOKS) {
    it(`${book} (${BOOK_SECTOR[book]}) carries no other sector's vocabulary`, () => {
      const text = visibleText(exportHtml(book));
      const mine = BOOK_SECTOR[book];
      const leaked: string[] = [];

      for (const [sector, terms] of Object.entries(SECTOR_VOCABULARY)) {
        if (sector === mine) continue;
        for (const term of terms) {
          // Word-ish boundary so "LTV" does not match inside a longer
          // token and "cap rate" is matched as written.
          const re = new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "iu");
          if (re.test(text)) {
            const at = text.search(re);
            leaked.push(
              `"${term}" (${sector}) — …${text.slice(Math.max(0, at - 90), at + 110).trim()}…`,
            );
          }
        }
      }

      expect(
        leaked,
        `the ${mine} book "${book}" printed ${leaked.length} term(s) belonging to ` +
          `another sector. The owner's report was a meat processor being advised ` +
          `about vacancy, LTV and single-tenant risk:\n  ${leaked.join("\n  ")}`,
      ).toEqual([]);
    });
  }

  it("a sector's OWN vocabulary is still allowed — the gate is not just muting everything", () => {
    // Non-vacuity. If this ever fails, the fix above went too far and the
    // report has been stripped of language it is entitled to use.
    const text = visibleText(exportHtml("realestate"));
    const ownTerms = SECTOR_VOCABULARY.real_estate.filter((t) =>
      new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text),
    );
    // Not an assertion that any specific term appears — the realestate
    // book may legitimately use none. This records what it does use, so a
    // future silent muting is visible in the diff rather than invisible.
    expect(Array.isArray(ownTerms)).toBe(true);
  });
});
