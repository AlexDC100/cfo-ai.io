// ONE VERDICT LEAVES THE BUILDING.
//
//     EVERY SURFACE THAT CAN CARRY A LETTER GRADE, AN ALTMAN SCORE, A
//     ZONE OR A DISTRESS VERDICT OUT OF THIS PRODUCT TAKES ALL FOUR FROM
//     THE ONE CREDIT READER, AND NAMES THE MODEL THAT MINTED THEM.
//
// ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────
//
// `oneLetterOneLadder.test.tsx` closed four surfaces — /report Section 7,
// the Risks tab, the hero chip and the exported workbook — by rendering
// each one and reading the letter back out of the DOM or out of the
// .xlsx bytes. It did not enumerate the fifth: the standalone HTML
// board pack, wired to a live button in the Export tab ONE CARD to the
// left of the XLSX button it did fix, whose own copy promises the
// document "prints to PDF cleanly … [includes] bankruptcy assessment".
//
// ─── WHAT WAS MEASURED, BEFORE THE FIX ─────────────────────────────────
//
// Real corpus period (`design_review/capsule/fixtures/period-scandia-
// fy2025.json` — Scandia FY2025, composite 24.4 / CC / engine Z" 0.22),
// rendered by the real renderer and read out of the produced bytes:
//
//   same period, same click, one card apart on the same screen
//     Risks tab / hero / /report / workbook   Z" 0.22   Distress   CC
//     HTML report -> PDF                      Z" 0.19   badge v-critical
//                                             "Bankruptcy risk: distress
//                                              zone. Action required."
//
//   and the document contained NO letter grade, NO composite, NO scoring
//   model and NO Piotroski anywhere in it — grep for "Credit", "Rating",
//   "Grade", "Composite", "Scoring model" over the whole file: all false.
//
//   Planting an engine re-band (letter_grade "B" with its own ladder,
//   Z" 3.50) moved every screen and the workbook to B / 3.50 / Safe.
//   This document did not move AT ALL: it had nothing in it that could.
//
// `renderReportHtml(s)` took one argument. It called `computeRatios(s)`
// with no engine metric map and had no credit reader at all, then
// rendered `ratioGroup("Distress Models", r.bankruptcy)` — a Z" computed
// by an arithmetic that exists nowhere else in the product, banded by a
// ladder that uses `>=` where every other surface uses `>`.
//
// ─── THREE ARITHMETICS, ONE NAME ───────────────────────────────────────
//
// "Altman Z-double-prime (1995 EM)" was claimed by three computations:
//
//   1. the ENGINE's, read through `altmanFromEngine`      0.22
//   2. `altmanZScore(s)`, the credit reader's FE fallback 0.20131
//   3. `computeRatios`' inline formula in the bankruptcy
//      group                                              0.18590918
//
// (2) and (3) disagreed even with each other, so THREADING THE ENGINE
// METRIC MAP INTO (3) WAS NEVER THE FIX — it makes them agree only while
// `calculated_metrics.altman_z_score` happens to arrive. §4 plants
// exactly that.
//
// (3) is deleted: `RatioBundle` no longer has a `bankruptcy` field, and
// the row every surface renders is `altmanRatio(credit)` — a projection
// of (1)-or-(2), whichever the ONE reader chose, carrying that reader's
// score, its zone, its threshold ladder and its verdict sentence.
//
// (1) and (2) survive because they genuinely measure different things —
// different operands (engine-emitted components against the served
// statements) and different models — and they are therefore NEVER
// unnamed: every surface that prints either one prints `credit.model`
// beside it, and §5 asserts that as one law over every surface at once.
//
// ─── HOW THIS FILE GATES ───────────────────────────────────────────────
//
// It RENDERS THE REAL DOCUMENT through the real entry point the Export
// tab calls, and PARSES THE PRODUCED HTML with DOMParser. Nothing about
// the template is asserted; every number and every word is read back out
// of the bytes. A test that mocked the renderer is the shape that let
// all of this live (see §6, which plants the pre-fix renderer and proves
// this file reds naming the document).

import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import * as XLSX from "xlsx";

import { buildReportHtml, buildExcelWorkbook } from "@/lib/financialExports";
import {
  altmanRatio,
  computeRatios,
  deriveTotals,
  verdictLabel,
  type Ratio,
  type Statements,
} from "@/lib/financialReport";
import { factsFrom } from "@/lib/servedFacts";
import {
  altmanZoneOf,
  computeCreditScore,
  engineCreditResult,
  spellLadder,
} from "@/lib/financialValuation";
import { creditCardData, readCreditFromMetrics } from "@/components/cfo/CreditScoreCard";
import { lookupConcept } from "@/lib/learning/concepts";
import { getRatioKnowledge } from "@/lib/ratioKnowledge";

// ─── The real corpus period ─────────────────────────────────────────────

const CORPUS = resolve(
  __dirname,
  "../../../design_review/capsule/fixtures/period-scandia-fy2025.json",
);
/* eslint-disable @typescript-eslint/no-explicit-any */
interface Corpus {
  statements: Statements;
  assembled_metrics: { credit?: any; piotroski?: any };
  metrics?: Array<{ name: string; value: number | null }>;
}
const RAW = JSON.parse(readFileSync(CORPUS, "utf-8")) as Corpus;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** One mutable copy of the whole period. Mutations below are PLANTS. */
function freshPeriod(): Corpus {
  return clone(RAW);
}
/** The envelopes object the Export tab hands to BOTH deliverables. */
function envelopesOf(p: Corpus) {
  const m: Record<string, number | null> = {};
  for (const x of p.metrics ?? []) m[x.name] = x.value;
  return {
    credit: p.assembled_metrics?.credit,
    piotroski: p.assembled_metrics?.piotroski,
    metricsByName: m,
  };
}
function readerFor(p: Corpus) {
  const e = envelopesOf(p);
  return computeCreditScore(p.statements, e.credit, e.piotroski, e.metricsByName);
}

// ─── SURFACE A — the printed document, PARSED FROM ITS OWN BYTES ────────
//
// Not the template, not a fragment: `buildReportHtml` produces the whole
// `<!doctype html>` string the Export tab writes to disk, and every
// assertion below reads it through DOMParser.

interface PrintedDoc {
  letter: string | null;
  letterModel: string | null;
  score: string | null;
  ladder: string | null;
  altmanLabel: string | null;
  altmanValue: string | null;
  altmanBadge: string | null;
  altmanZone: string | null;
  altmanVerdictText: string;
  /** Every distinct label in the document that claims to be an Altman. */
  altmanClaims: { label: string; value: string }[];
  /** The document's rendered TEXT. Assertions about wording read this, not
   *  `raw`: the model label contains "<" ("CC<25") and the renderer escapes
   *  it, so a substring search over the bytes would miss a sentence that is
   *  plainly on the page. */
  text: string;
  raw: string;
}

function printedDoc(p: Corpus, envelopes = envelopesOf(p)): PrintedDoc {
  const html = buildReportHtml(p.statements, envelopes);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const text = (sel: string): string | null => {
    const el = doc.querySelector(sel);
    return el ? (el.textContent ?? "").trim() : null;
  };
  const letterEl = doc.querySelector("[data-report-credit-letter]");
  const verdictEl = doc.querySelector("[data-report-altman-verdict]");
  // The Altman card, found by its LABEL rather than by a test id, so a
  // second Altman card added tomorrow without one is still counted.
  const claims: { label: string; value: string }[] = [];
  for (const card of Array.from(doc.querySelectorAll(".ratio-card"))) {
    const label = (card.querySelector(".label")?.textContent ?? "").trim();
    if (!/^Altman /i.test(label)) continue;
    claims.push({ label, value: (card.querySelector(".value")?.textContent ?? "").trim() });
  }
  const altmanCard = Array.from(doc.querySelectorAll(".ratio-card")).find((c) =>
    /^Altman /i.test((c.querySelector(".label")?.textContent ?? "").trim()),
  );
  return {
    letter: letterEl ? (letterEl.textContent ?? "").trim() : null,
    letterModel: letterEl?.getAttribute("data-model") ?? null,
    score: text("[data-report-credit-score]"),
    ladder: text("[data-report-credit-ladder]"),
    altmanLabel: altmanCard ? (altmanCard.querySelector(".label")?.textContent ?? "").trim() : null,
    altmanValue: altmanCard ? (altmanCard.querySelector(".value")?.textContent ?? "").trim() : null,
    altmanBadge: altmanCard ? (altmanCard.querySelector(".badge")?.textContent ?? "").trim() : null,
    altmanZone: verdictEl?.getAttribute("data-zone") ?? null,
    altmanVerdictText: (verdictEl?.textContent ?? "").trim(),
    altmanClaims: claims,
    text: (doc.body.textContent ?? "").replace(/\s+/g, " "),
    raw: html,
  };
}

// ─── SURFACE B — the Ratios tab's Bankruptcy-risk group ─────────────────
//
// The tab renders `altmanRatio(heroCredit)` beside the five
// `computeRatios` groups. This is the row it renders, built the way the
// page builds it.
function ratiosTabAltman(p: Corpus): Ratio {
  return altmanRatio(readerFor(p));
}

// ─── SURFACE C — the workbook, read back from its BYTES ─────────────────
function workbookFromBytes(p: Corpus): XLSX.WorkBook {
  const wb = buildExcelWorkbook(p.statements, undefined, envelopesOf(p));
  const dir = mkdtempSync(join(tmpdir(), "one-verdict-"));
  const file = join(dir, "book.xlsx");
  try {
    XLSX.writeFile(wb, file);
    return XLSX.read(readFileSync(file), { type: "buffer" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function rowsOf(wb: XLSX.WorkBook, sheet: string): (string | number)[][] {
  return XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[sheet], { header: 1 });
}
function workbookAltman(wb: XLSX.WorkBook): { sheet: string; cells: string[] }[] {
  const out: { sheet: string; cells: string[] }[] = [];
  for (const sheet of wb.SheetNames) {
    for (const r of rowsOf(wb, sheet)) {
      const cells = r.map((c) => String(c ?? ""));
      if (cells.some((c) => /^Altman /i.test(c))) out.push({ sheet, cells });
    }
  }
  return out;
}
function workbookLetter(wb: XLSX.WorkBook): string | null {
  const row = rowsOf(wb, "Credit & Risk").find((r) => String(r[0]) === "Rating");
  return row ? String(row[1]) : null;
}

// ════════════════════════════════════════════════════════════════════════
// §0 NON-VACUITY — the document really is produced, and really carries a
//    verdict. Every assertion below is about a document that says
//    something; without this, a fix that emptied the section would pass
//    the whole file (TC-9).
// ════════════════════════════════════════════════════════════════════════

describe("§0 non-vacuity — the printed document exists and states a verdict", () => {
  it("it is a whole HTML document with the credit section in it", () => {
    const d = printedDoc(freshPeriod());
    expect(d.raw.startsWith("<!doctype html>")).toBe(true);
    expect(d.raw.length).toBeGreaterThan(20_000);
    const doc = new DOMParser().parseFromString(d.raw, "text/html");
    const headings = Array.from(doc.querySelectorAll("h2")).map((h) => h.textContent?.trim());
    expect(headings, `document headings: ${JSON.stringify(headings)}`).toContain("Credit & Distress");
    // The three statement/ratio sections are still there — this lane
    // replaced a section, it did not remove the report.
    expect(headings).toContain("Financial Statements");
    expect(headings).toContain("Leverage & Coverage");
  });

  it("intact: it prints the engine's letter, composite, model, ladder and Z\"", () => {
    const d = printedDoc(freshPeriod());
    expect(d.letter).toBe("CC");
    expect(d.letterModel).toBe("engine-canonical-v1");
    expect(d.score).toContain("24.4");
    expect(d.ladder, "the printed document shows no grade ladder").toContain("CCC ≥ 25");
    expect(d.altmanValue).toBe("0.22");
    expect(d.altmanZone).toBe("distress");
    expect(d.altmanVerdictText).toContain("Distress zone");
  });
});

// ════════════════════════════════════════════════════════════════════════
// §1 THE DEFECT, AS ONE COMPARISON.
//
// The document and the screens are stated as ONE set, so the failure
// message names the divergence rather than one side of it.
// ════════════════════════════════════════════════════════════════════════

describe("§1 the printed document and every screen carry ONE Altman", () => {
  it("document · Ratios tab · workbook · reader — one value", () => {
    const p = freshPeriod();
    const doc = printedDoc(p);
    const tab = ratiosTabAltman(p);
    const wbRows = workbookAltman(workbookFromBytes(p));
    const wbValues = wbRows.map((r) => {
      const i = r.cells.findIndex((c) => /^Altman /i.test(c));
      return r.cells[i + 1];
    });
    const reader = readerFor(p).altman.score;

    const seen = new Set<string>([
      doc.altmanValue ?? "∅",
      tab.value === null ? "∅" : tab.value.toFixed(2),
      ...wbValues,
      reader === null ? "∅" : reader.toFixed(2),
    ]);
    expect(
      seen.size,
      `four surfaces, Altmans ${JSON.stringify([...seen])} — document ${doc.altmanValue}, ` +
        `Ratios tab ${tab.value}, workbook ${JSON.stringify(wbValues)}, reader ${reader}`,
    ).toBe(1);
  });

  it("…and ONE name for it", () => {
    const p = freshPeriod();
    const doc = printedDoc(p);
    const wbRows = workbookAltman(workbookFromBytes(p));
    const names = new Set<string>([
      doc.altmanLabel ?? "∅",
      ratiosTabAltman(p).label,
      ...wbRows.map((r) => r.cells.find((c) => /^Altman /i.test(c))!),
    ]);
    expect(
      names.size,
      `one measure under ${names.size} names: ${JSON.stringify([...names])} — the two ` +
        `spellings of "Z-double-prime" read as two measures to anyone scanning the file`,
    ).toBe(1);
  });

  it("…and ONE verdict sentence, agreeing with the badge above it", () => {
    const p = freshPeriod();
    const doc = printedDoc(p);
    const tab = ratiosTabAltman(p);
    // The badge word and the sentence in the same document must describe
    // the same zone. The pre-fix document printed badge "Critical" over a
    // sentence computed from a different score.
    expect(doc.altmanBadge).toBe(verdictLabel(tab.verdict));
    expect(doc.altmanVerdictText).toContain(readerFor(p).components[0].read ?? "∅");
  });
});

// ════════════════════════════════════════════════════════════════════════
// §2 TC-2 — AN ENGINE RE-BAND MOVES EVERY ENUMERATED SURFACE TOGETHER.
//
// The critic's own plant, extended to the Z": the engine emits a new
// `letter_grade` alongside new `letter_grade_bands`, and a new Z" in the
// safe zone. Before the fix this moved four surfaces and left the printed
// document exactly where it was.
// ════════════════════════════════════════════════════════════════════════

/** Re-band the engine AND move its Z" into the safe zone. */
function reBanded(): Corpus {
  const p = freshPeriod();
  const c = p.assembled_metrics.credit;
  c.letter_grade = "B";
  c.letter_grade_bands = [
    { min: 90, grade: "AAA" }, { min: 70, grade: "AA" }, { min: 50, grade: "A" },
    { min: 40, grade: "BBB" }, { min: 30, grade: "BB" }, { min: 20, grade: "B" },
    { min: 10, grade: "CCC" }, { min: 0, grade: "CC" },
  ];
  c.altman_z_score = 3.5;
  const i = (p.metrics ?? []).findIndex((m) => m.name === "altman_z_score");
  if (i >= 0) p.metrics![i] = { name: "altman_z_score", value: 3.5 };
  else p.metrics!.push({ name: "altman_z_score", value: 3.5 });
  return p;
}

describe("§2 an engine re-band moves the printed document too", () => {
  it("the document follows the engine to B / 3.50 / Safe", () => {
    const d = printedDoc(reBanded());
    expect(
      d.letter,
      "the engine re-banded and the printed board pack did not move — before this " +
        "lane the document carried no letter at all, so it could not",
    ).toBe("B");
    expect(d.altmanValue).toBe("3.50");
    expect(d.altmanZone).toBe("safe");
    expect(d.altmanVerdictText).toContain("Safe zone");
    // The ladder the letter was banded with is ON THE PAGE, so a reader
    // can see WHICH ladder produced it.
    expect(d.ladder).toContain("B ≥ 20");
  });

  it("EVERY enumerated surface, stated as one comparison", () => {
    const p = reBanded();
    const doc = printedDoc(p);
    const wb = workbookFromBytes(p);
    const reader = readerFor(p);
    const letters = new Set([doc.letter, workbookLetter(wb), reader.rating]);
    expect(
      letters.size,
      `letters ${JSON.stringify([...letters])} — document / workbook / reader ` +
        `(the reader is what the Risks tab, the hero chip and /report Section 7 print)`,
    ).toBe(1);
    expect([...letters][0]).toBe("B");

    const zones = new Set([
      doc.altmanZone,
      ratiosTabAltman(p).verdict === "healthy" ? "safe" : "moved",
      reader.altman.zone,
    ]);
    expect(zones.size, `zones ${JSON.stringify([...zones])}`).toBe(1);
    expect([...zones][0]).toBe("safe");
  });
});

// ════════════════════════════════════════════════════════════════════════
// §3 THE BOUNDARY, WHERE THE WORD MATTERS MOST.
//
// The deleted bankruptcy row banded with `>=`; `zoneFor` — the mapping
// behind every other surface — bands with `>`, per Appendix A
// (`Z" > 2.60 -> SAFE`, `1.10 <= Z" <= 2.60 -> GREY`). Measured before
// the fix, at exactly 2.60 and exactly 1.10:
//
//     document / Ratios tab   "Healthy · Bankruptcy risk: low. Balance
//                              sheet structurally sound."
//     every other surface     Grey
//
//     document / Ratios tab   "Watch · grey zone. Monitor leverage…"
//     every other surface     Distress
// ════════════════════════════════════════════════════════════════════════

function atZ(z: number): Corpus {
  const p = freshPeriod();
  p.assembled_metrics.credit.altman_z_score = z;
  const i = (p.metrics ?? []).findIndex((m) => m.name === "altman_z_score");
  if (i >= 0) p.metrics![i] = { name: "altman_z_score", value: z };
  else p.metrics!.push({ name: "altman_z_score", value: z });
  return p;
}

describe("§3 the zone word is one word, swept across both thresholds", () => {
  for (const z of [3.0, 2.61, 2.6, 2.5999, 1.11, 1.1, 1.0999, 0.22]) {
    it(`Z" = ${z}`, () => {
      const p = atZ(z);
      const doc = printedDoc(p);
      const expected = altmanZoneOf(z);
      expect(
        doc.altmanZone,
        `the printed document places Z" = ${z} in "${doc.altmanZone}" and every ` +
          `other surface places it in "${expected}"`,
      ).toBe(expected);
      const tabVerdict = ratiosTabAltman(p).verdict;
      const tabZone =
        tabVerdict === "healthy" ? "safe" : tabVerdict === "watch" ? "grey" : "distress";
      expect(tabZone, `the Ratios tab says "${tabZone}"`).toBe(expected);
    });
  }

  it("non-vacuity: the sweep really does cross both bands", () => {
    expect(new Set([3.0, 2.6, 1.1, 0.22].map((z) => altmanZoneOf(z))).size).toBe(3);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §4 THE PLANT THAT DEFEATS A HALF-FIX.
//
// Threading the engine metric map into the deleted inline formula would
// have made the surfaces agree ONLY while `calculated_metrics.
// altman_z_score` happened to arrive. Delete that ONE row: the credit
// reader still answers 0.22 (it falls back to the credit envelope's own
// `altman_z_score`), and the inline formula fell back to its own
// arithmetic and answered 0.18590918 again. Measured, both before and as
// the reason the group is deleted rather than re-plumbed.
// ════════════════════════════════════════════════════════════════════════

describe("§4 delete only calculated_metrics.altman_z_score", () => {
  it("the document, the tab, the workbook and the reader all still say 0.22", () => {
    const p = freshPeriod();
    const e = envelopesOf(p);
    delete e.metricsByName.altman_z_score;
    const doc = printedDoc(p, e);
    const wb = buildExcelWorkbook(p.statements, undefined, e);
    const wbAltman = workbookAltman(wb).map((r) => {
      const i = r.cells.findIndex((c) => /^Altman /i.test(c));
      return r.cells[i + 1];
    });
    const reader = computeCreditScore(p.statements, e.credit, e.piotroski, e.metricsByName);
    const tab = altmanRatio(reader);
    const seen = new Set<string>([
      doc.altmanValue ?? "∅",
      tab.value === null ? "∅" : tab.value.toFixed(2),
      ...wbAltman,
    ]);
    expect(
      seen.size,
      `one engine row deleted and the surfaces split: ${JSON.stringify([...seen])}`,
    ).toBe(1);
    expect([...seen][0]).toBe("0.22");
  });

  it("envelope gone, METRIC ROWS INTACT — the document stays on the engine", () => {
    // ⚠ THIS CASE USED TO ASSERT THE OPPOSITE, and that was F2. Deleting
    // the envelope while `calculated_metrics` still carries the engine's
    // composite, Z" and seven sub-scores is not "no engine claim" — it is
    // the production shape CLAUDE.md §14 records, and answering it with a
    // second model put 24.4 on one surface and 36 on another.
    const p = freshPeriod();
    const e = envelopesOf(p);
    delete e.credit;
    delete e.piotroski;
    const doc = printedDoc(p, e);
    const reader = computeCreditScore(p.statements, undefined, undefined, e.metricsByName);
    expect(reader.model).toBe("engine-canonical-v1");
    expect(reader.score, "one period, one composite").toBe(24.4);
    expect(reader.altman.score, "one period, one Altman").toBe(0.22);
    expect(reader.rating, "the metric rows carry no ladder, so no letter").toBeNull();
    expect(doc.letter).toBe("not reported");
    expect(doc.altmanValue).toBe("0.22");
    // …and it still SAYS which model produced the composite it is showing.
    expect(doc.text).toContain(reader.modelLabel);
  });

  it("and with the engine silent on BOTH paths, they still agree — on the OTHER model", () => {
    const p = freshPeriod();
    const e = envelopesOf(p);
    delete e.credit;
    delete e.piotroski;
    e.metricsByName = {};
    const doc = printedDoc(p, e);
    const reader = computeCreditScore(p.statements, undefined, undefined, {});
    expect(reader.model).toBe("client-fallback-v1");
    expect(doc.letterModel).toBe("client-fallback-v1");
    expect(doc.letter).toBe(reader.rating);
    expect(doc.altmanValue).toBe(reader.altman.score!.toFixed(2));
    // …and the document SAYS which model, in words, not just an id.
    expect(doc.text).toContain(reader.modelLabel);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §5 THE LAW, AS ONE STATEMENT: A VERDICT IMPLIES A NAMED MODEL.
//
// Two computations legitimately survive under the name "Altman Z-double-
// prime" — the engine's and the client fallback's — because they measure
// different things off different operands. That is exactly why neither
// may travel unnamed.
// ════════════════════════════════════════════════════════════════════════

describe("§5 no surface prints a verdict that names no model", () => {
  for (const [name, mutate] of [
    ["intact", (e: ReturnType<typeof envelopesOf>) => e],
    ["no credit envelope", (e: ReturnType<typeof envelopesOf>) => { delete e.credit; return e; }],
    ["no piotroski envelope", (e: ReturnType<typeof envelopesOf>) => { delete e.piotroski; return e; }],
    ["no metric map", (e: ReturnType<typeof envelopesOf>) => { e.metricsByName = {}; return e; }],
    ["empty credit envelope", (e: ReturnType<typeof envelopesOf>) => { e.credit = {}; return e; }],
  ] as const) {
    it(`${name}`, () => {
      const p = freshPeriod();
      const e = mutate(envelopesOf(p));
      const doc = printedDoc(p, e);
      const reader = computeCreditScore(p.statements, e.credit, e.piotroski, e.metricsByName);

      if (doc.letter !== null && doc.letter !== "not reported") {
        expect(doc.letterModel, "the document printed a letter naming no model").not.toBe("none");
        expect(
          doc.text.includes(reader.modelLabel),
          "the document printed a letter without the model SENTENCE beside it",
        ).toBe(true);
      }
      if (doc.altmanValue !== null && doc.altmanValue !== "not reported") {
        expect(
          doc.altmanVerdictText,
          "the document printed an Altman verdict naming no model",
        ).toContain(reader.modelLabel);
      }
      // The workbook, on the same envelopes, over the same law.
      const wb = buildExcelWorkbook(p.statements, undefined, e);
      const letter = workbookLetter(wb);
      if (letter && letter !== "not reported") {
        const modelRow = rowsOf(wb, "Credit & Risk").find((r) => String(r[0]) === "Scoring model");
        expect(modelRow?.[1], "the workbook printed a letter naming no model").toBe(reader.model);
      }
    });
  }

  it("a refused verdict is a REFUSAL, never a distress reading", () => {
    // An empty engine envelope is the engine's credit claim for a period
    // it could not score. The document must say so — and must not paint
    // the absence in the colour reserved for the distressed band.
    const p = freshPeriod();
    const e = envelopesOf(p);
    e.credit = {};
    e.metricsByName = {};
    const doc = printedDoc(p, e);
    expect(doc.letter).toBe("not reported");
    expect(doc.altmanValue).toBe("not reported");
    expect(doc.altmanBadge).toBe("Not reported");
    expect(doc.altmanZone).toBe("none");
    expect(
      doc.altmanVerdictText.toLowerCase(),
      "an unmeasurable Z\" was worded as a finding about the company",
    ).toContain("do not read it as distress");
    expect(doc.altmanVerdictText.toLowerCase()).not.toContain("distress zone");
  });
});

// ════════════════════════════════════════════════════════════════════════
// §6 THE PRE-FIX RENDERER, PLANTED — this gate must RED, naming the
//    document.
//
// The plant is the pre-fix computation, reproduced exactly: the inline
// Z" formula `computeRatios` used to carry (deleted from the bundle) and
// the `>=` verdict ladder that went with it, rendered as the row the
// document used to print. If this file could pass with that row in the
// document, it would be gating nothing.
// ════════════════════════════════════════════════════════════════════════

describe("§6 the deleted arithmetic, planted, is caught", () => {
  /** The pre-fix bankruptcy row, VERBATIM.
   *
   *  Operands are the ones the deleted code used — the servedFacts
   *  gateway totals and `B("retainedEarnings")`, i.e. the FE-PARSED
   *  retained-earnings line rather than the engine book's
   *  `retained_earnings + current_year_pnl` the credit reader uses. That
   *  one substitution is the entire 0.22 / 0.19 gap, and reproducing it
   *  here is what makes this plant the real thing rather than an
   *  approximation of it: the constant below is asserted to two decimals
   *  AND the divergence is asserted structurally, so a drifted plant is
   *  loud rather than quietly vacuous. */
  function preFixBankruptcyRow(s: Statements): Ratio {
    const sf = factsFrom(s);
    const t = deriveTotals(s);
    const ta = sf.totalAssets()!;
    const tl = sf.totalLiabilities()!;
    const te = sf.totalEquity()!;
    const wc = sf.workingCapital()!;
    const z =
      6.56 * (wc / ta) +
      3.26 * ((s.balanceSheet.retainedEarnings + t.netIncome) / ta) +
      6.72 * (t.ebit / ta) +
      1.05 * (te / tl);
    return {
      key: "altman_z",
      label: "Altman Z″-Score",
      value: z,
      unit: "ratio",
      // The `>=` ladder, exactly as it was.
      verdict: z >= 3 ? "strong" : z >= 2.6 ? "healthy" : z >= 1.1 ? "watch" : "critical",
      benchmark: "≥ 2.60 safe · 1.10–2.60 grey · < 1.10 distress (Z″ 1995 EM)",
      commentary:
        z >= 2.6
          ? "Bankruptcy risk: low. Balance sheet structurally sound."
          : z >= 1.1
            ? "Bankruptcy risk: grey zone. Monitor leverage and cash flow."
            : "Bankruptcy risk: distress zone. Action required.",
    };
  }

  it("PLANT: the pre-fix row disagrees with the reader on the real corpus", () => {
    const p = freshPeriod();
    const planted = preFixBankruptcyRow(p.statements);
    const reader = readerFor(p).altman.score!;
    expect(
      planted.value!.toFixed(2),
      "the planted pre-fix arithmetic no longer diverges — this plant has gone " +
        "stale and §6 is asserting nothing",
    ).not.toBe(reader.toFixed(2));
    expect(planted.value!.toFixed(2)).toBe("0.19");
    expect(reader.toFixed(2)).toBe("0.22");
  });

  it("PLANT: §1's comparison reds, and its message names the document", () => {
    const p = freshPeriod();
    const doc = printedDoc(p);
    const planted = preFixBankruptcyRow(p.statements);
    // Substituting the planted row for the document's own is what the
    // pre-fix renderer did. §1's set therefore has two members.
    const seen = new Set<string>([
      planted.value!.toFixed(2),
      ratiosTabAltman(p).value!.toFixed(2),
      readerFor(p).altman.score!.toFixed(2),
    ]);
    expect(seen.size).toBe(2);
    // …and the document, with the fix, is on the reader's side of it.
    expect(doc.altmanValue).toBe("0.22");
  });

  it("PLANT: §3's boundary sweep reds on the pre-fix ladder", () => {
    // The planted ladder and the reader's ladder disagree at exactly the
    // two threshold values, and nowhere else.
    const plantedZone = (z: number) => (z >= 2.6 ? "safe" : z >= 1.1 ? "grey" : "distress");
    const disagreements = [3.0, 2.61, 2.6, 2.5999, 1.11, 1.1, 1.0999].filter(
      (z) => plantedZone(z) !== altmanZoneOf(z),
    );
    expect(
      disagreements,
      "the pre-fix ladder no longer disagrees anywhere — §3 would be vacuous",
    ).toEqual([2.6, 1.1]);
  });

  it("PLANT: the pre-fix DOCUMENT wording is nowhere in the produced bytes", () => {
    const d = printedDoc(freshPeriod());
    for (const phrase of [
      "Bankruptcy risk: low. Balance sheet structurally sound.",
      "Bankruptcy risk: grey zone. Monitor leverage and cash flow.",
      "Bankruptcy risk: distress zone. Action required.",
      "Distress Models",
    ]) {
      expect(
        d.text.includes(phrase),
        `the printed document still carries the deleted vocabulary ${JSON.stringify(phrase)} — ` +
          "its verdict words must be the credit reader's own",
      ).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// §7 THE OTHER TWO LADDERS THIS SWEEP FOUND — both reachable by tapping
//    the number the four proven surfaces print.
//
// They were never export surfaces, which is exactly why nothing looked
// at them. Both minted a zone word from a band table of their own.
// ════════════════════════════════════════════════════════════════════════

describe("§7 the learning popover and the ratio drawer band with the ONE ladder", () => {
  it("the popover's Altman narrative agrees with the chip it opens from", () => {
    const c = lookupConcept("altman_z_score");
    expect(c?.interpretation, "the Altman concept lost its interpretation").toBeTruthy();
    for (const z of [3.0, 2.61, 2.6, 2.5999, 1.11, 1.1, 1.0999, 0.22]) {
      const zone = altmanZoneOf(z);
      const narrative = c!.interpretation!.getNarrative(z);
      const said = /^Safe zone/.test(narrative)
        ? "safe"
        : /^Grey zone/.test(narrative)
          ? "grey"
          : "distress";
      expect(
        said,
        `Z" = ${z}: the chip says "${zone}" and the popover you open by TAPPING IT ` +
          `says ${JSON.stringify(narrative)}`,
      ).toBe(zone);
      const sentiment = c!.interpretation!.getSentiment(z);
      expect(sentiment).toBe(zone === "safe" ? "positive" : zone === "grey" ? "neutral" : "negative");
    }
  });

  it("the popover no longer claims a LETTER band for the composite", () => {
    // "Investment-grade equivalent" at >= 75 was a replica grade ladder in
    // prose: the engine bands A at >= 70 and ships its ladder per period,
    // so an engine re-band moved the letter on four surfaces and left this
    // sentence exactly where it was.
    const c = lookupConcept("composite_credit_score");
    for (const v of [95, 80, 72, 60, 30, 10]) {
      const narrative = c!.interpretation!.getNarrative(v);
      expect(
        /investment[- ]grade|speculative[- ]grade/i.test(narrative),
        `composite ${v}: the popover claims a letter band — ${JSON.stringify(narrative)}`,
      ).toBe(false);
    }
    // Non-vacuity: it still SAYS something about the score.
    expect(c!.interpretation!.getNarrative(95)).not.toBe(c!.interpretation!.getNarrative(10));
  });

  it("the ratio drawer explains the model the row actually runs", () => {
    const k = getRatioKnowledge({ key: "altman_z" } as Ratio);
    expect(k, "the drawer has no entry for the Altman row").toBeTruthy();
    // ⚠ IT DESCRIBED Z(1968): coefficients 1.2/1.4/3.3/0.6/1.0 with a
    // Sales/TA term Z" does not have, and the ladder "< 1.8 distress",
    // under the label "Altman Z″-Score". At Z" = 1.50 the row said Grey
    // and this drawer said "structurally distressed", one click apart.
    expect(k!.formula).toContain("6.56");
    expect(k!.formula).toContain("1.05");
    expect(k!.formula, "the drawer still prints the 1968 coefficients").not.toContain("3.3·");
    expect(k!.formula, "Z\" has no sales/total-assets term").not.toMatch(/Sales\/TA/);
    for (const s of [k!.goodRange, k!.whyItMatters]) {
      expect(s, `the drawer still prints a 1.80 distress threshold: ${JSON.stringify(s)}`).not.toContain("1.8");
    }
    expect(k!.goodRange).toContain("2.60");
    expect(k!.goodRange).toContain("1.10");
  });

  it("the drawer's ladder is the module's own thresholds, not a copy that drifted", () => {
    // Read the thresholds back out of the reader and require the drawer's
    // printed range to quote THOSE numbers, so moving the threshold moves
    // the explanation with it.
    const th = readerFor(freshPeriod()).altman.thresholds;
    const k = getRatioKnowledge({ key: "altman_z" } as Ratio)!;
    expect(k.goodRange).toContain(th.safe.toFixed(2));
    expect(k.goodRange).toContain(th.distress.toFixed(2));
  });
});

// ════════════════════════════════════════════════════════════════════════
// §7b /report SECTION 7 HELD A SECOND READER — one that read only ONE of
//     the engine's two emission paths.
//
// `readCreditFromMetrics` took `calculated_metrics` and nothing else,
// while `computeCreditScore` (the Risks tab, the hero chip, the workbook
// and now the printed document) takes `calculated_metrics` FIRST and the
// credit envelope SECOND. Both are the engine's own emissions of the same
// figures. Measured on the real Scandia period with the envelope fully
// intact — composite 24.4, letter CC, Z" 0.22, all seven sub-scores:
//
//   delete calculated_metrics.altman_z_score
//     /report Section 7   THE WHOLE CARD AND ITS KPI VANISHED
//     every other surface CC / 24.4 / 0.22, unchanged
//   delete the seven calculated_metrics.credit_subscore_* rows
//     /report Section 7   seven "not reported" rows
//     every other surface 7.9 / 1.9 / 39.6 / 40 / 70 / 32.7 / 29.4
//   delete calculated_metrics.altman_x1..x4
//     /report Section 7   four "not reported" rows
//     every other surface −0.0371 / −0.0294 / 0.0561 / 0.1723
//
// Whether a surface HAS a verdict is as much a verdict as the verdict.
// ════════════════════════════════════════════════════════════════════════

describe("§7b /report's card reads the same two authorities, in the same order", () => {
  function cardFor(p: Corpus, mutate: (m: Record<string, number | null>) => void) {
    const e = envelopesOf(p);
    mutate(e.metricsByName);
    return {
      card: readCreditFromMetrics(e.metricsByName, e.credit),
      shared: computeCreditScore(p.statements, e.credit, e.piotroski, e.metricsByName),
    };
  }

  it("non-vacuity: intact, the card and the shared reader agree", () => {
    const { card, shared } = cardFor(freshPeriod(), () => undefined);
    expect(card).not.toBeNull();
    expect(card!.composite).toBe(shared.score);
    expect(card!.altmanZ).toBe(shared.altman.score);
    expect(card!.letter).toBe(shared.rating);
  });

  it("delete calculated_metrics.altman_z_score — the card still scores the period", () => {
    const { card, shared } = cardFor(freshPeriod(), (m) => { delete m.altman_z_score; });
    expect(
      card,
      "/report Section 7 lost its whole card off ONE engine row, while every other " +
        "surface kept printing CC / 24.4 / 0.22",
    ).not.toBeNull();
    expect(card!.altmanZ).toBe(shared.altman.score);
    expect(card!.letter).toBe(shared.rating);
  });

  it("delete calculated_metrics.credit_composite — same", () => {
    const { card, shared } = cardFor(freshPeriod(), (m) => { delete m.credit_composite; });
    expect(card).not.toBeNull();
    expect(card!.composite).toBe(shared.score);
  });

  it("delete the seven sub-score rows — the card reads the envelope's", () => {
    const { card, shared } = cardFor(freshPeriod(), (m) => {
      for (const k of Object.keys(m)) if (k.startsWith("credit_subscore_")) delete m[k];
    });
    expect(card).not.toBeNull();
    // The shared reader's rows, in its own order: [Altman, profitability,
    // leverage, coverage, dscr, liquidity, equity].
    const sharedValues = shared.components.slice(1).map((c) => c.value);
    expect([
      card!.subscores.profitability, card!.subscores.leverage,
      card!.subscores.coverage, card!.subscores.dscr,
      card!.subscores.liquidity, card!.subscores.equity,
    ]).toEqual(sharedValues);
    expect(sharedValues.every((v) => v !== null), "the plant emptied both authorities").toBe(true);
  });

  it("delete altman_x1..x4 — the card reads the envelope's components", () => {
    const { card, shared } = cardFor(freshPeriod(), (m) => {
      for (const k of ["altman_x1", "altman_x2", "altman_x3", "altman_x4"]) delete m[k];
    });
    expect(card).not.toBeNull();
    expect([card!.altmanX1, card!.altmanX2, card!.altmanX3, card!.altmanX4]).toEqual([
      shared.altman.components.x1_wc_to_assets,
      shared.altman.components.x2_re_to_assets,
      shared.altman.components.x3_ebit_to_assets,
      shared.altman.components.x4_equity_to_liabilities,
    ]);
    expect(card!.altmanX1, "the plant emptied both authorities").not.toBeNull();
  });

  it("BOTH authorities absent is still a refusal — the fix did not invent a figure", () => {
    const p = freshPeriod();
    const e = envelopesOf(p);
    e.metricsByName = {};
    e.credit = {};
    expect(readCreditFromMetrics(e.metricsByName, e.credit)).toBeNull();
    // …and with an envelope carrying components but no score, the
    // components render and the score does not.
    const partial = readCreditFromMetrics(
      { credit_composite: 24.4, altman_z_score: 0.22 },
      { altman_components: { x1: -0.0371 }, subscores: { altman: 7.9 } },
    );
    expect(partial!.altmanX1).toBe(-0.0371);
    expect(partial!.altmanX2).toBeNull();
    expect(partial!.subscores.altman).toBe(7.9);
    expect(partial!.subscores.dscr).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// §8 THE SURFACE THAT MUST NOT EXIST: a second Altman anywhere in the
//    produced document, or a `bankruptcy` group on the bundle.
// ════════════════════════════════════════════════════════════════════════

describe("§8 one document, one Altman", () => {
  it("exactly one Altman card in the printed bytes", () => {
    const d = printedDoc(freshPeriod());
    expect(
      d.altmanClaims.length,
      `the document carries ${d.altmanClaims.length} Altman cards: ${JSON.stringify(d.altmanClaims)}`,
    ).toBe(1);
  });

  it("the bundle has no `bankruptcy` group left to render", () => {
    const bundle = computeRatios(freshPeriod().statements);
    expect(
      Object.keys(bundle).sort(),
      "a `bankruptcy` group is back on the bundle — that is the third arithmetic returning",
    ).toEqual(["coverage", "efficiency", "leverage", "liquidity", "profitability"]);
    // Non-vacuity: the bundle still produces the ratios it should.
    expect(Object.values(bundle).flat().length).toBeGreaterThanOrEqual(20);
  });

  it("no ratio anywhere in the bundle claims to be an Altman", () => {
    const rows = Object.values(computeRatios(freshPeriod().statements)).flat();
    const claims = rows.filter((r) => /altman/i.test(r.key) || /^Altman /i.test(r.label));
    expect(
      claims.map((r) => r.key),
      "computeRatios is minting an Altman again — the row belongs to the credit reader",
    ).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §9 THE READER EACH SURFACE ACTUALLY USES — enumerated, and planted
//    against the replica ladder that MUST disagree.
//
// ⚠ THE GAP THIS CLOSES (G1). §2 above re-bands the engine and then
// checks the printed document, the workbook and `computeCreditScore`.
// `/report` Section 7 does NOT call `computeCreditScore` — it calls
// `readCreditFromMetrics`, a different entry point — so §2 never
// exercised the one surface the replica ladder actually lived on. It
// stayed 41/41 GREEN with the replica restored inside that function,
// and its own non-vacuity check passed for the worst possible reason:
// the replica AGREES with the engine at the corpus composite (both say
// CC at 24.4), so an assertion that the card says CC is satisfied by
// either model. The closure was real, but it was defended by
// `oneLetterOneLadder.test.tsx`, not by this file.
//
// Two changes fix that, and both are needed:
//   1. every surface is called through THE FUNCTION IT ACTUALLY CALLS,
//      named beside it, so adding a surface means adding a row here;
//   2. the plant is a re-band under which the REPLICA'S ANSWER DIFFERS,
//      asserted to differ before anything else is checked — so a green
//      run cannot be a coincidence of two ladders agreeing.
// ════════════════════════════════════════════════════════════════════════

/** The band table `CreditScoreCard.compositeToGrade()` held, verbatim —
 *  the locked F1.h ladder. It is the PLANT REFERENCE: nothing in the
 *  product may reproduce it, and every assertion below is stated against
 *  what it would have answered. */
const REPLICA_F1H_BANDS: Array<{ min: number; grade: string }> = [
  { min: 90, grade: "AAA" }, { min: 80, grade: "AA" }, { min: 70, grade: "A" },
  { min: 60, grade: "BBB" }, { min: 50, grade: "BB" }, { min: 40, grade: "B" },
  { min: 25, grade: "CCC" }, { min: 0, grade: "CC" },
];
function replicaLetter(composite: number): string {
  let best = REPLICA_F1H_BANDS[REPLICA_F1H_BANDS.length - 1];
  for (const b of REPLICA_F1H_BANDS) if (composite >= b.min && b.min >= best.min) best = b;
  return best.grade;
}

/** Every surface that can print the letter, each through the entry point
 *  IT calls. The names are the app's, not this file's. */
function lettersBySurface(p: Corpus): Record<string, string | null> {
  const e = envelopesOf(p);
  // /report Section 7 — ComprehensiveReport.tsx calls exactly this.
  const card = readCreditFromMetrics(e.metricsByName, e.credit ?? null);
  // The dashboard hero (HeroVerdictCard) and the Risks tab both render
  // `computeCreditScore(...).rating` off the same memo.
  const shared = computeCreditScore(p.statements, e.credit, e.piotroski, e.metricsByName);
  // The printed board pack, from its own bytes.
  const doc = printedDoc(p, e);
  // The workbook, from its own bytes.
  const wb = workbookFromBytes(p);
  return {
    "/report Section 7 · readCreditFromMetrics": card?.letter ?? null,
    "dashboard hero · computeCreditScore": shared.rating,
    "Risks tab · computeCreditScore": shared.rating,
    "printed board pack · buildReportHtml": doc.letter === "not reported" ? null : doc.letter,
    "workbook · buildExcelWorkbook": (() => {
      const l = workbookLetter(wb);
      return l === null || l === "not reported" ? null : l;
    })(),
  };
}

/** Re-band the engine so the composite (24.4) lands on a grade the
 *  REPLICA could never produce for it. */
function reBandedAwayFromReplica(): Corpus {
  const p = freshPeriod();
  const c = p.assembled_metrics.credit;
  c.letter_grade = "B";
  c.letter_grade_bands = [
    { min: 90, grade: "AAA" }, { min: 70, grade: "AA" }, { min: 50, grade: "A" },
    { min: 40, grade: "BBB" }, { min: 30, grade: "BB" }, { min: 20, grade: "B" },
    { min: 10, grade: "CCC" }, { min: 0, grade: "CC" },
  ];
  return p;
}

describe("§9 every surface, through its own reader, under a plant the replica cannot pass", () => {
  it("PLANT LIVENESS: the replica and the engine DISAGREE on this period", () => {
    const p = reBandedAwayFromReplica();
    const shared = computeCreditScore(
      p.statements, envelopesOf(p).credit, envelopesOf(p).piotroski, envelopesOf(p).metricsByName,
    );
    expect(shared.score, "the corpus composite moved — the plant below is calibrated to it").toBe(24.4);
    expect(shared.rating).toBe("B");
    expect(
      replicaLetter(shared.score!),
      "the deleted replica ladder now AGREES with the engine on this period, so every " +
        "assertion in this section could be satisfied by the replica — re-band further apart",
    ).not.toBe(shared.rating);
    expect(replicaLetter(24.4)).toBe("CC");
  });

  it("the replica AGREES on the intact corpus — which is why §2's plant proved nothing here", () => {
    // Stated as a test so the reason this section exists cannot be
    // deleted as an unexplained duplicate of §2.
    const intact = computeCreditScore(
      freshPeriod().statements,
      envelopesOf(freshPeriod()).credit,
      envelopesOf(freshPeriod()).piotroski,
      envelopesOf(freshPeriod()).metricsByName,
    );
    expect(intact.rating).toBe("CC");
    expect(replicaLetter(intact.score!)).toBe("CC");
  });

  it("all five surfaces follow the engine to B — and none of them says CC", () => {
    const p = reBandedAwayFromReplica();
    const bySurface = lettersBySurface(p);
    const letters = new Set(Object.values(bySurface));
    expect(
      letters.size,
      `five surfaces, letters ${JSON.stringify(bySurface)}`,
    ).toBe(1);
    expect([...letters][0]).toBe("B");
    for (const [surface, letter] of Object.entries(bySurface)) {
      expect(
        letter,
        `${surface} printed the REPLICA's answer — a frontend band table is alive on it`,
      ).not.toBe(replicaLetter(24.4));
    }
  });

  it("non-vacuity: every enumerated surface really produced a letter", () => {
    const bySurface = lettersBySurface(reBandedAwayFromReplica());
    expect(Object.keys(bySurface).length).toBeGreaterThanOrEqual(5);
    for (const [surface, letter] of Object.entries(bySurface)) {
      expect(letter, `${surface} produced no letter at all — it is asserting nothing`).not.toBeNull();
    }
  });

  it("the /report card is a PROJECTION of the shared reader, not a second one", () => {
    // Field by field, on the plant. A second reader can agree on the
    // letter and still disagree on the number under it — which is F2.
    const p = reBandedAwayFromReplica();
    const e = envelopesOf(p);
    // Through the REAL entry point `/report` calls, not through the
    // projection helper — a plant that wraps this function would
    // otherwise slip past a test that reaches around it.
    const card = readCreditFromMetrics(e.metricsByName, e.credit ?? null)!;
    // …and the projection helper itself agrees with it, so the entry
    // point is proven to be a thin call rather than a second reader.
    expect(card).toEqual(creditCardData(engineCreditResult(e.credit, undefined, e.metricsByName)));
    const shared = computeCreditScore(p.statements, e.credit, e.piotroski, e.metricsByName);
    expect(card.composite).toBe(shared.score);
    expect(card.altmanZ).toBe(shared.altman.score);
    expect(card.letter).toBe(shared.rating);
    expect(card.model).toBe(shared.model);
    expect(card.modelLabel).toBe(shared.modelLabel);
    expect(card.ladder).toEqual(shared.letterBands);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §10 NO CUTOFF IS WRITTEN AS PROSE — read out of the produced bytes.
//
// ⚠ F1, AND THIS PROGRAMME MADE IT WORSE. The replica ladder deleted from
// the code survived as a SENTENCE in two places: `CREDIT_MODEL_LABEL`
// ("AAA≥90 … CC<25") and the engine caveat ("AAA ≥ 90, AA ≥ 80, A ≥ 70,
// BBB ≥ 60, BB ≥ 50, B ≥ 40, CCC ≥ 25, CC < 25"). Under §9's re-band,
// measured out of the produced document bytes:
//
//   data-report-credit-ladder  "… B ≥ 20 · CCC ≥ 10 · CC ≥ 0"   MOVED
//   credit.modelLabel          "… AAA≥90 … CC<25"               FROZEN
//   credit.caveat              "… B ≥ 40, CCC ≥ 25, CC < 25 …"  FROZEN
//
// Three claims inside one section: the letter is B, the ladder puts B at
// 20, and two lines later B is at 40. The workbook carried the frozen
// sentence on TWO sheets. The gate asserted the ladder ELEMENT and never
// read the rest of the text, which is why it was green throughout.
//
// This section reads every GRADE-and-a-number pair out of the whole
// document and the whole workbook, and requires each one to be a pair
// the reader's OWN ladder contains.
// ════════════════════════════════════════════════════════════════════════

/** Every "<GRADE> ≥ <n>" / "<GRADE> < <n>" claim in a blob of text. */
function bandClaimsIn(text: string): string[] {
  const rx = /\b(AAA|AA|BBB|BB|CCC|CC|A|B|D)\s*(?:≥|>=|<=|<|>)\s*(\d+(?:\.\d+)?)/g;
  const out: string[] = [];
  for (const m of text.matchAll(rx)) out.push(`${m[1]}@${Number(m[2])}`);
  return out;
}
/** The pairs the reader's own ladder licenses. */
function licensedClaims(bands: Array<{ min: number; grade: string }> | null): Set<string> {
  return new Set((bands ?? []).map((b) => `${b.grade}@${b.min}`));
}
/** Every string cell in the whole workbook, as one blob. */
function workbookText(wb: XLSX.WorkBook): string {
  const parts: string[] = [];
  for (const sheet of wb.SheetNames) {
    for (const r of rowsOf(wb, sheet)) for (const c of r ?? []) parts.push(String(c ?? ""));
  }
  return parts.join(" \n ");
}

describe("§10 no sentence names a cutoff the letter was not banded with", () => {
  for (const [name, make] of [
    ["intact corpus", () => freshPeriod()],
    ["engine re-banded", () => reBandedAwayFromReplica()],
    // The OTHER model carried its own frozen prose ladder ("bands
    // A ≥ 85 … CC ≥ 0") for exactly the same reason, so it is swept too.
    ["client fallback", () => {
      const p = freshPeriod();
      delete p.assembled_metrics.credit;
      delete p.assembled_metrics.piotroski;
      p.metrics = [];
      return p;
    }],
  ] as const) {
    it(`${name}: the printed document`, () => {
      const p = make();
      const e = envelopesOf(p);
      const reader = computeCreditScore(p.statements, e.credit, e.piotroski, e.metricsByName);
      const doc = printedDoc(p, e);
      const licensed = licensedClaims(reader.letterBands);
      const stray = bandClaimsIn(doc.text).filter((c) => !licensed.has(c));
      expect(
        stray,
        `the document names cutoffs its own ladder does not contain: ${JSON.stringify(stray)} — ` +
          `licensed ${JSON.stringify([...licensed])}. A band written as prose does not move on a re-band.`,
      ).toEqual([]);
    });

    it(`${name}: the exported workbook`, () => {
      const p = make();
      const e = envelopesOf(p);
      const reader = computeCreditScore(p.statements, e.credit, e.piotroski, e.metricsByName);
      const licensed = licensedClaims(reader.letterBands);
      const stray = bandClaimsIn(workbookText(workbookFromBytes(p))).filter((c) => !licensed.has(c));
      expect(
        stray,
        `the workbook names cutoffs its own ladder does not contain: ${JSON.stringify(stray)}`,
      ).toEqual([]);
    });

    it(`${name}: the model label and the caveat are composed from the ladder`, () => {
      const p = make();
      const e = envelopesOf(p);
      const reader = computeCreditScore(p.statements, e.credit, e.piotroski, e.metricsByName);
      const spelled = spellLadder(reader.letterBands);
      expect(spelled, "the reader carries no ladder on a period that has one").toBeTruthy();
      expect(
        reader.modelLabel,
        "the model label does not carry THIS period's ladder",
      ).toContain(spelled!);
      expect(
        reader.caveat,
        "the caveat does not carry THIS period's ladder",
      ).toContain(spelled!);
    });
  }

  it("PLANT LIVENESS: the frozen sentences are gone from the produced bytes", () => {
    // The exact strings that used to ship. If any of them can be found in
    // a deliverable again, the prose ladder is back.
    const p = reBandedAwayFromReplica();
    const e = envelopesOf(p);
    const doc = printedDoc(p, e);
    const wbText = workbookText(workbookFromBytes(p));
    for (const frozen of [
      "AAA≥90 … CC<25",
      "A≥85 … CC≥0",
      "AAA ≥ 90, AA ≥ 80, A ≥ 70, BBB ≥ 60, BB ≥ 50, B ≥ 40, CCC ≥ 25, CC < 25",
      "bands A ≥ 85 … CC ≥ 0",
      "the locked F1.h ladder",
    ]) {
      expect(doc.text.includes(frozen), `the document still carries ${JSON.stringify(frozen)}`).toBe(false);
      expect(wbText.includes(frozen), `the workbook still carries ${JSON.stringify(frozen)}`).toBe(false);
    }
    // Non-vacuity: the detector really does find claims when they exist,
    // and the frozen sentence really would have been caught.
    expect(bandClaimsIn("AAA≥90 … CC<25")).toEqual(["AAA@90", "CC@25"]);
    expect(
      bandClaimsIn("AAA≥90 … CC<25").filter((c) => !licensedClaims(
        computeCreditScore(p.statements, e.credit, e.piotroski, e.metricsByName).letterBands,
      ).has(c)),
      "the re-banded ladder happens to license the frozen pairs — the plant is inert",
    ).not.toEqual([]);
  });
});
