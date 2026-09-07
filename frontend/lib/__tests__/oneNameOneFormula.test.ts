/**
 * R1 — ONE NAME, ONE FORMULA, in the printed export.
 *
 * The owner read one Agras document and found three things wearing the
 * words "interest coverage". Parsing the real bytes found that and two
 * more, on all four books:
 *
 *   Equity Ratio                              60.9%    §Capital Structure
 *   Equity ratio                             100.00    §Credit component table
 *   Interest Coverage (EBITDA / Interest)     66.28×   §Debt Coverage
 *   Interest Coverage (EBIT / Interest)       95.00    §Credit component table
 *
 * The credit rows are 0–100 SUB-SCORES. 95.00 is not 95× of anything —
 * EBIT ÷ interest on that book is 55.64× — it is the score the model
 * banded that ratio into. So one document answered "what is the equity
 * ratio" with 60.9% and 100.00, and "what is interest coverage" with
 * 66.28× and 95.00, in a column headed "Value" both times.
 *
 * WHY THE HEADLINE VALUE DID NOT MOVE. `interest_coverage` is the
 * engine's canonical metric and it is EBITDA ÷ interest
 * (`pipeline.py:2226`, `safe(ebitda, interest)`). The dashboard, the
 * covenant screens, `periodFacts`, the Capsule and the credit reader all
 * read that one row. The credit model's coverage sub-score is banded on
 * EBIT ÷ interest (`pipeline.py:2423`, `operating_profit / interest`) —
 * a genuinely different number the model needs. Both are real, so both
 * are shown, each naming its own basis; NEITHER basis was changed, so
 * nothing downstream of this document moved. That is the resolution the
 * brief offers as the alternative to picking one basis, and it is the
 * one a document with a credit model in it can actually honour.
 *
 * WHAT THIS GATE REDS ON, AFTER THE REPAIR (TC-11)
 *   · a concept printed twice with different bases where any printing
 *     leaves its label unqualified — the "Equity ratio 60.9% / Equity
 *     ratio 100.00" shape;
 *   · a concept printed on two different SCALES — a ratio (× or %) in
 *     one place and a bare score in another — even when both labels are
 *     qualified. That is the interest-coverage shape, and label
 *     qualification alone did not save it.
 *
 * WHAT IT CANNOT SEE
 *   · a concept the two harvesters do not reach. It reads `.ratio-card`
 *     labels + their `.formula` line, and the credit component table.
 *     Prose, recommendation cards and table row labels are not harvested,
 *     so a metric named only in a sentence is invisible here.
 *   · the FE-fallback credit model (`financialValuation.ts`'s non-engine
 *     branch), whose rows print the RATIO rather than a sub-score. All
 *     four committed books carry an engine credit envelope, so that
 *     branch renders in no document this gate reads.
 *   · two printings that agree on scale and basis but disagree on VALUE.
 *     `oneConceptOneValue` covers that; this gate is about names.
 *   · the deliberately-kept pair `DSCR (interest + ST debt)` /
 *     `DSCR (incl. LT principal proxy)` — two qualified labels, same
 *     scale, adjacent in one section, each naming its denominator. That
 *     is "both bases, distinctly named, in the same place", which is the
 *     accepted shape, not the defect.
 */

import { describe, expect, it } from "vitest";

import { BOOKS, exportDoc, type Book } from "./exportBooks";

interface Printing {
  /** The label exactly as the document prints it. */
  label: string;
  /** The arithmetic the document DECLARES for it, or null when it
   *  declares none. Never the label standing in for a formula: a
   *  printing that states no basis has not stated a *different* one,
   *  and treating it as one made this gate red on the Altman row, which
   *  prints the same concept, the same value and the same scale twice
   *  and is the shape we want. */
  basis: string | null;
  /** "ratio" when the printed figure carries × or %, "score" when bare. */
  scale: "ratio" | "score" | "money" | "days" | "absent";
  where: string;
  printed: string;
}

/** The bare concept a label names, with any qualifier removed. */
function concept(label: string): string {
  return label
    .replace(/\(.*?\)/g, " ")
    .replace(/[–—-]/g, " ")
    .replace(/[^A-Za-z0-9″"\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Does the label qualify itself — a parenthetical or an explicit basis? */
function qualified(label: string): boolean {
  return /\(.+\)/.test(label);
}

function scaleOf(printed: string): Printing["scale"] {
  const t = printed.replace(/[   ]/g, " ").trim();
  if (t === "" || /not reported|not graded/i.test(t)) return "absent";
  if (/[×x]\s*$/.test(t)) return "ratio";
  if (/%/.test(t)) return "ratio";
  if (/\bdays?\b/i.test(t)) return "days";
  if (/RON|EUR|USD|€|\$/.test(t)) return "money";
  return "score";
}

function printingsIn(doc: Document): Printing[] {
  const out: Printing[] = [];
  doc.querySelectorAll(".ratio-card").forEach((c) => {
    const label = (c.querySelector(".label")?.textContent ?? "").replace(/\s+/g, " ").trim();
    const printed = (c.querySelector(".value")?.textContent ?? "").replace(/\s+/g, " ").trim();
    const formula = (c.querySelector(".formula")?.textContent ?? "").replace(/\s+/g, " ").trim();
    if (label === "") return;
    out.push({
      label,
      basis: formula !== "" ? formula : (label.match(/\((.+)\)/)?.[1] ?? null),
      scale: scaleOf(printed),
      where: "ratio card",
      printed,
    });
  });
  doc.querySelectorAll("table").forEach((tbl) => {
    const head = (tbl.querySelector("thead")?.textContent ?? "").replace(/\s+/g, " ");
    if (!/Component/.test(head) || !/Contribution/.test(head)) return;
    tbl.querySelectorAll("tbody tr").forEach((tr) => {
      const tds = Array.from(tr.querySelectorAll("td"));
      if (tds.length < 2) return;
      const label = (tds[0].textContent ?? "").replace(/\s+/g, " ").trim();
      const printed = (tds[1].textContent ?? "").replace(/\s+/g, " ").trim();
      if (label === "") return;
      out.push({
        label,
        basis: label.match(/\((.+)\)/)?.[1] ?? null,
        scale: scaleOf(printed),
        where: "credit component table",
        printed,
      });
    });
  });
  return out;
}

function group(printings: Printing[]): Map<string, Printing[]> {
  const by = new Map<string, Printing[]>();
  for (const p of printings) {
    const c = concept(p.label);
    if (!by.has(c)) by.set(c, []);
    by.get(c)!.push(p);
  }
  return by;
}

const show = (ps: Printing[]): string =>
  ps
    .map(
      (p) =>
        `\n      ${p.where}: "${p.label}" = ${p.printed} [${p.scale}] :: ` +
        (p.basis === null ? "<no basis declared>" : p.basis.slice(0, 90)),
    )
    .join("");

describe("R1 — no metric name carries two formulas in one printed export", () => {
  it("is not vacuous: the harvester finds both surfaces on every book", () => {
    for (const book of BOOKS) {
      const ps = printingsIn(exportDoc(book));
      expect(ps.filter((p) => p.where === "ratio card").length, book).toBeGreaterThanOrEqual(15);
      expect(ps.filter((p) => p.where === "credit component table").length, book).toBeGreaterThanOrEqual(6);
      // and it really does see a repeated concept, so the grouping works
      expect([...group(ps).values()].some((g) => g.length > 1), book).toBe(true);
    }
  });

  it.each(BOOKS)("%s: a concept printed with two bases names the basis every time", (book: Book) => {
    for (const [c, ps] of group(printingsIn(exportDoc(book)))) {
      const bases = new Set(ps.map((p) => p.basis).filter((b): b is string => b !== null));
      if (bases.size < 2) continue;
      const bare = ps.filter((p) => !qualified(p.label));
      expect(
        bare,
        `"${c}" is printed with ${bases.size} different bases, and ${bare.length} printing(s) ` +
          `do not say which one they are:${show(ps)}`,
      ).toEqual([]);
    }
  });

  it.each(BOOKS)("%s: a concept is never printed as a ratio here and a score there", (book: Book) => {
    for (const [c, ps] of group(printingsIn(exportDoc(book)))) {
      const scales = new Set(ps.map((p) => p.scale).filter((s) => s !== "absent"));
      expect(
        [...scales].sort(),
        `"${c}" is printed on ${scales.size} different scales — a reader asking for it ` +
          `gets numbers that are not comparable:${show(ps)}`,
      ).toEqual(scales.size === 0 ? [] : [[...scales][0]]);
    }
  });
});
