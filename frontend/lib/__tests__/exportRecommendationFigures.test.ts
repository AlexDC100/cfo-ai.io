// G5 — A RECOMMENDATION MAY ONLY CITE FIGURES THE REPORT STATES.
//
// A recommendation is advice about the company in front of the reader.
// Every number in it is therefore a claim about THIS period, and a
// reader who wants to check one has exactly one place to look: the rest
// of the same document. Until 2026-09-07 the printed report broke that
// on every book, because `generateRecommendations` ignored the
// `RatioBundle` it was handed and computed a DSCR of its own:
//
//   §Debt Coverage card        EBITDA ÷ (interest + short-term debt)
//   §Recommendations           EBITDA ÷ (interest + max(10% of debt, D&A))
//
//   book         the card says   the recommendations said
//   agras            7.43×               5.70×   (×3 in one card set)
//   carniprod    not reported            2.59×
//
// carniprod is the sharper one: the ratio table REFUSES to state a DSCR
// (interest expense is zero, so the ratio is undefined), and the
// recommendation quoted 2.59× anyway — a figure the document states
// nowhere, about a quantity the document says it cannot compute.
//
// WHAT THIS GATE ASSERTS. Every multiple and every currency amount
// printed inside a recommendation must be one of exactly three things:
//   (a) a figure the document states elsewhere — any ratio card, any
//       executive-strip card, any cell of the financial statements;
//   (b) a covenant TARGET, declared below with the band it belongs to —
//       "≥ 1.25×" is advice, not a measurement of this company;
//   (c) a quantity DERIVED from stated figures, declared below with its
//       derivation written out.
// Anything else is a recommendation citing a number out of the air, and
// the failure message says which card and which figure.
//
// WHAT IT REDS ON, after the repair (TC-11): a rule re-pointed at a
// ratio the report does not print; a new rule quoting a threshold nobody
// declared; the recommendation path drifting back onto its own
// arithmetic for any ratio (the `stated()` bridge in
// `generateRecommendations` going away reds this on agras immediately).
//
// WHAT IT CANNOT SEE: PROSE. "Current DSCR −5.86× and Debt/EBITDA −0.64×
// have meaningful headroom" cites two figures the report states and is
// still nonsense about a negative DSCR — the words are not checked here,
// and that defect is reported to the owner rather than gated. It also
// does not check percentages inside advice ("refinance 30–50%"), which
// are targets by construction, nor the counts inside sentences ("2–3
// lenders", "13-week forecast").

import { describe, expect, it } from "vitest";

import {
  BOOKS,
  type Book,
  exportDoc,
  parsePrinted,
  ratioCards,
  recommendationTexts,
  statementsFor,
} from "./exportBooks";

/** Covenant targets and monitoring bands — advice, not measurement. */
const COVENANT_TARGETS: Array<{ value: number; what: string }> = [
  { value: 1.25, what: "the covenant-typical DSCR floor this report benchmarks against" },
  { value: 1.3, what: "the AMBER/RED DSCR boundary of the monitoring dashboard rule" },
  { value: 1.5, what: "the GREEN DSCR boundary of the monitoring dashboard rule" },
  { value: 5.5, what: "the GREEN/AMBER Debt-EBITDA boundary of the monitoring dashboard rule" },
  { value: 6.5, what: "the AMBER/RED Debt-EBITDA boundary of the monitoring dashboard rule" },
];

/** Amounts a rule computes from figures the document states. */
const DERIVED: Array<{
  what: string;
  of: (doc: Document, env: { bs: Record<string, number> }) => number[];
}> = [
  {
    what: "50bps of total debt — the annual saving a refinance rule quotes",
    of: (_doc, env) => [env.bs.total_debt * 0.005],
  },
  {
    what: "zero — a rule naming an income line the period does not carry",
    of: () => [0],
  },
];

/** Every figure the document states, anywhere a reader can see it.
 *
 *  An expense row prints its magnitude inside parentheses — "(RON
 *  277,930)" — which is a presentation of the same figure a sentence
 *  quotes as "RON 277,930". Both signs are registered, so the gate reads
 *  the accounting convention rather than treating it as a second number. */
function statedFigures(doc: Document): Array<{ n: number; where: string }> {
  const out: Array<{ n: number; where: string }> = [];
  for (const card of ratioCards(doc)) {
    const n = parsePrinted(card.value);
    if (n !== null) out.push({ n, where: `card “${card.label}”` });
  }
  for (const td of Array.from(doc.querySelectorAll("td.num"))) {
    const label = (td.parentElement?.querySelector("td")?.textContent ?? "").trim();
    const n = parsePrinted((td.textContent ?? "").trim());
    if (n === null) continue;
    out.push({ n, where: `statement row “${label}”` });
    if (n < 0) out.push({ n: -n, where: `statement row “${label}” (magnitude)` });
  }
  return out;
}

/** Half a display step of the figure AS PRINTED in the sentence: "RON
 *  18K" carries 500 of slack, "RON 277,930" carries 0.5. Comparing a
 *  compacted figure against an exact one on a fixed tolerance would be
 *  checking a rounding. */
function slack(printed: string, magnitudeOfValue: number): number {
  const compacted = /\d\s*[KMB]/.test(printed);
  if (!compacted) return Math.max(Math.abs(magnitudeOfValue) * 0.005, 0.006);
  const decimals = (printed.match(/[.](\d+)\s*[KMB]/) ?? [, ""])[1]?.length ?? 0;
  const unit = /\d\s*B/.test(printed) ? 1e9 : /\d\s*M/.test(printed) ? 1e6 : 1e3;
  return unit / Math.pow(10, decimals) / 2;
}

const near = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(Math.abs(b) * 0.005, 0.006);

interface Cited {
  printed: string;
  value: number;
  kind: "multiple" | "money";
}

/** Every multiple and currency amount a recommendation card prints. */
function citedFigures(text: string): Cited[] {
  const out: Cited[] = [];
  // A "−" that follows a digit is a RANGE dash ("1.30-1.50×", "5.5-6.5×"),
  // not a sign. Reading it as one invents figures the sentence never
  // stated and hides the ones it did.
  for (const m of text.matchAll(/(?<![\d.])(-?[\d][\d,]*\.?\d*)\s*×/g)) {
    const v = parsePrinted(m[1]);
    if (v !== null) out.push({ printed: m[0], value: v, kind: "multiple" });
  }
  for (const m of text.matchAll(/RON\s(-?[\d][\d,]*\.?\d*\s?[KMB]?)/g)) {
    const v = parsePrinted(m[0]);
    if (v !== null) out.push({ printed: m[0], value: v, kind: "money" });
  }
  return out;
}

describe("G5 — every figure in a recommendation is a figure the report states", () => {
  for (const book of BOOKS) {
    it(`${book}: no recommendation cites a number the document does not carry`, () => {
      const doc = exportDoc(book as Book);
      const env = { bs: statementsFor(book as Book).assembled_bs ?? {} };
      const stated = statedFigures(doc);
      const derived = DERIVED.flatMap((d) => d.of(doc, env).map((n) => ({ n, what: d.what })));
      const failures: string[] = [];

      for (const text of recommendationTexts(doc)) {
        const title = text.slice(0, 90);
        for (const cite of citedFigures(text)) {
          const tol = slack(cite.printed, cite.value);
          const close = (target: number) => Math.abs(cite.value - target) <= Math.max(tol, Math.abs(target) * 0.005, 0.006);
          if (stated.some((s) => close(s.n))) continue;
          if (cite.kind === "multiple" && COVENANT_TARGETS.some((t) => close(t.value))) continue;
          if (derived.some((d) => close(d.n))) continue;
          failures.push(
            `${book}: the recommendation “${title}…” cites ${cite.printed} — the document ` +
              `states no such figure anywhere, it is not a declared covenant target, and it ` +
              `is not derived from a stated figure`,
          );
        }
      }
      expect(failures, `${book}: a recommendation cites a figure the report never states`).toEqual(
        [],
      );
    });

    it(`${book}: the DSCR a recommendation quotes is the DSCR the ratio table states`, () => {
      // The named half of the law, so the general assertion above cannot
      // pass by accident when a wrong DSCR happens to collide with some
      // other figure printed elsewhere on the page.
      const doc = exportDoc(book as Book);
      const card = ratioCards(doc).find((c) => c.label === "DSCR (interest + ST debt)");
      expect(card, `${book}: the document prints no DSCR card`).toBeTruthy();
      const stated = parsePrinted(card!.value);
      for (const text of recommendationTexts(doc)) {
        for (const m of text.matchAll(/DSCR\s+(?:from\s+|of\s+)?(-?[\d][\d,]*\.?\d*)\s*×/g)) {
          const quoted = parsePrinted(m[1]);
          if (quoted === null) continue;
          if (stated === null) {
            throw new Error(
              `${book}: the ratio table REFUSES to state a DSCR for this period and a ` +
                `recommendation quotes ${m[0]}`,
            );
          }
          expect(
            Math.abs(quoted - stated),
            `${book}: a recommendation quotes ${m[0]} while the ratio table states ` +
              `${card!.value} — one concept, two values, in one document`,
          ).toBeLessThanOrEqual(0.006);
        }
      }
    });
  }

  it("the declared covenant targets are actually used, and are targets", () => {
    // Non-vacuity: a permanently-unused allow-list entry is a hole, not a
    // rule. Every target below must appear in at least one book's cards.
    const seen = new Set<number>();
    for (const book of BOOKS) {
      const doc = exportDoc(book as Book);
      for (const text of recommendationTexts(doc)) {
        for (const c of citedFigures(text)) {
          const hit = COVENANT_TARGETS.find((t) => near(c.value, t.value));
          if (hit) seen.add(hit.value);
        }
      }
    }
    const unused = COVENANT_TARGETS.filter((t) => !seen.has(t.value)).map((t) => t.value);
    expect(unused, "a declared covenant target no recommendation ever prints").toEqual([]);
  });
});
