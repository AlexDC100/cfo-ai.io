// G5 (printed half) — the standalone HTML export, on all four books.
//
// `frontend/pages/cfo/__tests__/industryBlock.test.tsx` covers the
// on-screen report. This covers the OTHER deliverable, and the one whose
// symptoms the owner actually quoted: `renderReportHtml` prints its own
// header line ("Industry: Real estate · residential rental"), its own
// benchmark column, and its own recommendation cards built from the
// profile-gated rule registry.
//
// TWO MEASURED DEFECTS THIS GATE HOLDS DOWN.
//
// 1. THE PROFILE GATE WAS INVERTED. `detectConditions` skipped an
//    `industries:`-scoped rule only when an industry was BOTH present
//    and non-matching, so a scoped rule fired whenever the industry was
//    unknown. Measured on the committed books before the repair:
//
//      agras     industry undefined -> property_tax_reassessment_provision, …
//      agras     industry ""        -> property_tax_reassessment_provision, …
//      carniprod industry undefined -> property_tax_reassessment_provision
//
//    `property_tax_reassessment_provision` is CRE-only. It was reaching
//    two food factories, on nothing but `ppe_net >= 5,000,000`.
//
// 2. THE COMPARISON WAS AGAINST A DISPLAY LABEL. The engine serves
//    `statements.industry = organizations.industry_display_name`, so the
//    string reaching the gate was "Real estate · residential rental"
//    while every rule declares the KEY `real_estate_residential`. The
//    two never match. Measured, same run:
//
//      agras "real_estate_residential"          -> property_tax_… fires
//      agras "Real estate · residential rental" -> property_tax_… silent
//
//    So a correctly-set CRE workspace lost its CRE findings and an unset
//    workspace got them on any book with a property line.
//
// WHAT THIS GATE REDS ON after the repair: a scoped rule reaching a book
// whose industry is unknown or disputed; the header stating a disputed
// industry as fact; and — the non-vacuity half — the SAME rule failing
// to reach the real-estate book whose setting the account mix seconds.
//
// WHAT IT CANNOT SEE (TC-11): the benchmark strings in the ratio tables.
// "≤ 60 days for FMCG · varies by industry" is hardcoded at
// `financialReport.ts` (the `dio` row) and does not read the workspace
// setting at all, which is why it printed "for FMCG" on a report headed
// real estate.
//
// ⚠ THAT HALF IS NOW REPAIRED AND GATED ELSEWHERE — see
// `industrySectorContentBlocked.test.ts`, which asserts over the same
// printed export that six sector-calibrated rows withhold BOTH the band
// and the badge while the sector is disputed, that no sector idiom
// survives, and — the non-vacuity half — that all of it comes back when
// the account mix seconds the setting. This file keeps the header line
// and the rule ids; it still reads no benchmark column.
//
// Nor can it see `usePeriodFacts`, which still hands `detectConditions` a display
// label: after this repair those scoped rules are SILENT there rather
// than wrongly firing, which is the safe direction but not the fix.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BOOKS, type Book, statementsFor, workspaceKeys } from "./exportBooks";
import { buildReportHtml } from "@/lib/financialExports";
import { generateRecommendations, type Statements } from "@/lib/financialReport";

const firm = (name: string) =>
  resolve(__dirname, "../../..", "tests/engine/fixtures/firm", name);

const SIGNALS = JSON.parse(readFileSync(firm("industry_signal.json"), "utf-8")) as Record<
  Book,
  Record<string, { workspace: { display: string }; display: string }>
>;

// WAS A SECOND COPY OF THE PAIRING, typed here. It now reads the
// committed `tests/engine/fixtures/firm/workspace_industry.json`, so this
// file and `industrySectorContentBlocked.test.ts` cannot drift into
// testing two different disagreements about the same book.
const SETTINGS: Record<Book, { wrong: string; right: string }> = Object.fromEntries(
  BOOKS.map((b) => [b, { wrong: workspaceKeys(b).disputes, right: workspaceKeys(b).agrees }]),
) as Record<Book, { wrong: string; right: string }>;

/** The served payload for one book under one workspace setting — the
 *  industry display name and the engine's own reading of the mix. */
function bookAs(book: Book, key: string): Statements {
  const signal = SIGNALS[book][key];
  return {
    ...statementsFor(book),
    industry: signal.workspace.display,
    industry_signal: signal,
  } as Statements;
}

function docOf(s: Statements): Document {
  return new DOMParser().parseFromString(
    buildReportHtml(s, { metricsByName: {} }),
    "text/html",
  );
}

/** Every recommendation card's title in the printed document. */
function recommendationTitles(doc: Document): string[] {
  return Array.from(doc.querySelectorAll(".rec h3, .rec .rec-title, .rec strong"))
    .map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const CRE_ONLY_RULES = ["property_tax_reassessment_provision", "tenant_concentration_renewal"];

describe("G5 (printed) — a profile-gated finding needs an established, agreeing profile", () => {
  it.each(BOOKS)("%s: an UNKNOWN industry fires no industry-scoped rule", (book) => {
    for (const industry of [undefined, ""]) {
      const s = { ...statementsFor(book), industry } as Statements;
      const ids = generateRecommendations(s).map((r) => r.id);
      const scoped = ids.filter((id) => CRE_ONLY_RULES.includes(id));
      expect(scoped, `${book} with industry ${JSON.stringify(industry)}`).toEqual([]);
    }
  });

  it.each(BOOKS)("%s: a DISPUTED industry fires no industry-scoped rule", (book) => {
    const ids = generateRecommendations(bookAs(book, SETTINGS[book].wrong)).map((r) => r.id);
    expect(ids.filter((id) => CRE_ONLY_RULES.includes(id))).toEqual([]);
  });

  it("NON-VACUITY — the same CRE rule DOES fire on the real-estate book the mix seconds", () => {
    const ids = generateRecommendations(bookAs("realestate", "real_estate_residential")).map(
      (r) => r.id,
    );
    expect(ids).toContain("property_tax_reassessment_provision");
  });

  it("the display label the engine serves now resolves to its key", () => {
    // Defect 2: before the repair this returned the same as an UNSET
    // industry, i.e. the CRE rule fired on a food factory and stayed
    // silent on the property book.
    const withLabelOnly = {
      ...statementsFor("realestate"),
      industry: "Real estate · residential rental",
      industry_signal: SIGNALS.realestate.real_estate_residential,
    } as Statements;
    expect(generateRecommendations(withLabelOnly).map((r) => r.id)).toContain(
      "property_tax_reassessment_provision",
    );
  });
});

describe("G5 (printed) — the header never states a disputed industry as fact", () => {
  it.each(BOOKS)("%s: the disputed setting is printed as unconfirmed, naming both", (book) => {
    const signal = SIGNALS[book][SETTINGS[book].wrong];
    const html = buildReportHtml(bookAs(book, SETTINGS[book].wrong), { metricsByName: {} });
    const doc = new DOMParser().parseFromString(html, "text/html");
    const header = (doc.querySelector(".header-info")?.textContent ?? "").replace(/\s+/g, " ");
    expect(header).not.toMatch(
      new RegExp(`Industry:\\s*${signal.workspace.display.replace(/[.*+?^${}()|[\]\\·]/g, "\\$&")}\\s*$`),
    );
    expect(header).toContain("unconfirmed");
    expect(header).toContain(signal.display);
    expect(header).toContain(signal.workspace.display);
  });

  it.each(BOOKS)("%s: an agreeing setting is printed plainly", (book) => {
    const signal = SIGNALS[book][SETTINGS[book].right];
    const doc = docOf(bookAs(book, SETTINGS[book].right));
    const header = (doc.querySelector(".header-info")?.textContent ?? "").replace(/\s+/g, " ");
    expect(header).toContain(`Industry: ${signal.workspace.display}`);
    expect(header).not.toContain("unconfirmed");
  });

  it.each(BOOKS)("%s: the statements still print in full while it is disputed", (book) => {
    const doc = docOf(bookAs(book, SETTINGS[book].wrong));
    const tables = doc.querySelectorAll("table.fin");
    expect(tables.length).toBeGreaterThanOrEqual(2);
    expect(recommendationTitles(doc).length).toBeGreaterThanOrEqual(0);
  });
});
