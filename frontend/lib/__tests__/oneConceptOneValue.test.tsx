// G1 — ONE CONCEPT, ONE VALUE PER RENDERED REPORT.
//
// The report is one document. Where it states the same concept in more
// than one place, every place must state the same number. Read over the
// RENDERED output (TC-7) — the text a person sees — because the defect
// this gate exists for was invisible in the source data taken one field
// at a time: `assembled_pl.net_income_statutory` was correctly anchored
// to account 121, and `metrics.net_income_statutory` was correctly the
// class-6/7 reconstruction, and each was right about itself. Only on
// screen, where section 1 reads one and section 5 reads the other, did
// the report state two different net incomes.
//
// Measured on the current tree before the repair (2026-09-06), agras:
//
//   section 1 tile  "Net profit — statutory (ct 121)"   7.5 M RON
//   section 1 tile  ...its own margin sub-label            11.9 %
//                   (7,533,676 / 118,576,820 is 6.4 %)
//   section 1 tile  "ROE"                                  31.5 %
//   section 5 ratio "ROE"                                  59.0 %
//   section 5 ratio "Net margin"                           11.9 %
//
// Two ROEs and two net margins, printed 40 lines apart in one memo.
//
// WHAT IT REDS ON, after the repair (TC-11): any surface on this page
// picking its own net income again — a new tile, a new ratio row, a
// re-derivation in a component — because the pairs are compared as
// PRINTED, so a divergence anywhere in the chain that feeds either side
// shows up here. It covers net profit, net turnover, EBITDA and the
// three margins built on them, on all four firm books.
//
// WHAT IT CANNOT SEE: a concept the report states only ONCE. EBIT is
// rendered in exactly one place today (the P&L build-up), so a wrong
// EBIT would pass here — the envelope-level half of that law is
// `tests/engine/test_one_concept_one_value.py`, which compares the two
// served halves by name. It also cannot see whether the single agreed
// value is CORRECT; that is the anchor gate's job.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({ display: "RON", rates: { rates: {} } }),
  CurrencyProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => null }));
const stableToast = { toast: () => undefined };
vi.mock("@/hooks/use-toast", () => ({ useToast: () => stableToast }));
vi.mock("@/hooks/useActivePeriodFallback", () => ({
  useActivePeriodFallback: () => ({ periodId: "p", status: "resolved" }),
}));
vi.mock("@/components/learning/GuideMeButton", () => ({ GuideMeButton: () => null }));
vi.mock("@/components/learning/LearnableNumber", () => ({
  LearnableNumber: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/cfo/CreditScoreCard", () => ({
  CreditScoreCard: () => null,
  readCreditFromMetrics: () => null,
}));
vi.mock("@/components/cfo/RiskInventory", () => ({ RiskInventory: () => null }));
vi.mock("@/components/cfo/EbitdaReconciliationPanel", () => ({
  EbitdaReconciliationPanel: () => null,
}));

import { cleanup, screen } from "@testing-library/react";

import { BOOKS, type Book, halfStep, mountReport, parseMoney } from "./reportBooks";

// ── reading the rendered page ─────────────────────────────────────────

/** A KPI tile of section 1, located by the label it prints. */
function kpiTile(label: string): { value: string; sub: string } {
  const overview = screen.getByTestId("report-section-1-overview");
  for (const panel of Array.from(overview.querySelectorAll("div"))) {
    const kids = Array.from(panel.children);
    if (kids.length < 2) continue;
    if ((kids[0].textContent ?? "").trim() !== label) continue;
    return {
      value: (kids[1].textContent ?? "").replace(/\s+/g, " ").trim(),
      sub: (kids[2]?.textContent ?? "").replace(/\s+/g, " ").trim(),
    };
  }
  throw new Error(`section 1 states no KPI tile labelled ${JSON.stringify(label)}`);
}

/** The amount cell of the row labelled `label` inside a section. */
function rowValue(testId: string, label: string): string {
  const section = screen.getByTestId(testId);
  for (const tr of Array.from(section.querySelectorAll("tr"))) {
    const tds = Array.from(tr.querySelectorAll("td"));
    if (tds.length < 2) continue;
    if ((tds[0].textContent ?? "").replace(/\s+/g, " ").trim() !== label) continue;
    return (tds[1].textContent ?? "").replace(/\s+/g, " ").trim();
  }
  throw new Error(`${testId} states no row labelled ${JSON.stringify(label)}`);
}

/** Does a section render a row with this label? */
function hasRow(testId: string, label: string): boolean {
  const section = screen.getByTestId(testId);
  return Array.from(section.querySelectorAll("tr")).some((tr) => {
    const tds = Array.from(tr.querySelectorAll("td"));
    return (
      tds.length >= 2 &&
      (tds[0].textContent ?? "").replace(/\s+/g, " ").trim() === label
    );
  });
}

/** The leading percentage of a tile sub-label ("11.9% margin · …"). */
function leadingPercent(sub: string): string {
  const m = sub.match(/^([-\u2212]?[\d.,\u202f\u2009\u00a0]+%)/);
  if (!m) throw new Error(`no leading percentage in ${JSON.stringify(sub)}`);
  return m[1];
}

// ── the concepts this page states more than once ──────────────────────

type Statement = { where: string; printed: string };
type Concept = { concept: string; sites: () => Statement[] };

const CONCEPTS: Concept[] = [
  {
    concept: "net profit (account 121)",
    sites: () => [
      { where: "§1 tile “Net profit — statutory (ct 121)”", printed: kpiTile("Net profit — statutory (ct 121)").value },
      { where: "§2 the figure the P&L build-up ends on", printed: lastPnlRowValue() },
    ],
  },
  {
    concept: "net turnover",
    sites: () => [
      { where: "§1 tile “Net turnover”", printed: kpiTile("Net turnover").value },
      { where: "§1 tile “Net turnover” sub-line", printed: kpiTile("Net turnover").sub },
      { where: "§2 row “Net turnover”", printed: rowValue("report-section-2-pnl", "Net turnover") },
    ],
  },
  {
    concept: "EBITDA (reported / statutory)",
    sites: () => [
      { where: "§1 tile “EBITDA — reported”", printed: kpiTile("EBITDA — reported").value },
      // The build-up's EBITDA is the cash view. Where 722 is material the
      // two genuinely differ and the table renders the statutory figure as
      // its own memo row; that row is the one to compare against.
      {
        where: "§2 the EBITDA the build-up states",
        printed: hasRow("report-section-2-pnl", "EBITDA (statutory, incl. 722) — memo")
          ? rowValue("report-section-2-pnl", "EBITDA (statutory, incl. 722) — memo")
          : rowValue("report-section-2-pnl", "EBITDA"),
      },
    ],
  },
];

/** Percent concepts — compared as printed strings, already at one precision. */
const PERCENT_CONCEPTS: Concept[] = [
  {
    concept: "ROE",
    sites: () => [
      { where: "§1 tile “ROE”", printed: kpiTile("ROE").value },
      { where: "§5 ratio “ROE”", printed: rowValue("report-section-5-ratios", "ROE") },
    ],
  },
  {
    concept: "net margin",
    sites: () => [
      { where: "§1 tile “Net profit — statutory (ct 121)” sub-line", printed: leadingPercent(kpiTile("Net profit — statutory (ct 121)").sub) },
      { where: "§5 ratio “Net margin”", printed: rowValue("report-section-5-ratios", "Net margin") },
    ],
  },
  {
    concept: "EBITDA margin",
    sites: () => [
      { where: "§1 tile “EBITDA — reported” sub-line", printed: leadingPercent(kpiTile("EBITDA — reported").sub) },
      { where: "§5 ratio “EBITDA margin”", printed: rowValue("report-section-5-ratios", "EBITDA margin") },
    ],
  },
];

/** The last amount the P&L table prints — the figure the build-up ends on. */
function lastPnlRowValue(): string {
  const section = screen.getByTestId("report-section-2-pnl");
  const rows = Array.from(section.querySelectorAll("tr")).filter(
    (tr) => tr.querySelectorAll("td").length >= 2,
  );
  const last = rows[rows.length - 1];
  return (last.querySelectorAll("td")[1].textContent ?? "").replace(/\s+/g, " ").trim();
}

/** How many places each concept is read from, declared so the vacuity
 *  check does not have to render a page to count them. */
const SITE_COUNT: Record<string, number> = {
  "net profit (account 121)": 2,
  "net turnover": 3,
  "EBITDA (reported / statutory)": 2,
  ROE: 2,
  "net margin": 2,
  "EBITDA margin": 2,
};

describe("G1 — one concept, one value per rendered report", () => {
  beforeEach(() => cleanup());
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("names concepts the page really states twice", () => {
    // Not vacuous: every concept below must name at least two rendering
    // sites, or "the two agree" is a statement about nothing.
    const singletons = [...CONCEPTS, ...PERCENT_CONCEPTS]
      .filter((c) => SITE_COUNT[c.concept] < 2)
      .map((c) => c.concept);
    expect(singletons, "a concept with fewer than two rendering sites").toEqual([]);
    expect(CONCEPTS.length + PERCENT_CONCEPTS.length).toBeGreaterThanOrEqual(6);
  });

  for (const book of BOOKS) {
    it(`${book}: no two places state a different number for one concept`, async () => {
      await mountReport(book as Book);
      const failures: string[] = [];

      for (const { concept, sites } of CONCEPTS) {
        const stated = sites();
        // Each site must actually be a figure — a gap glyph in one place
        // and a number in another is also two answers.
        const parsed = stated.map((s) => ({ ...s, n: parseMoney(s.printed) }));
        const [first, ...rest] = parsed;
        for (const other of rest) {
          if (typeof first.n !== "number" || typeof other.n !== "number") {
            failures.push(
              `${concept}: ${first.where} shows ${JSON.stringify(first.printed)} and ` +
                `${other.where} shows ${JSON.stringify(other.printed)} — one of them is not a figure`,
            );
            continue;
          }
          const tolerance = Math.max(halfStep(first.printed), halfStep(other.printed));
          if (Math.abs(first.n - other.n) > tolerance) {
            failures.push(
              `${concept}: ${first.where} states ${first.printed} and ` +
                `${other.where} states ${other.printed}`,
            );
          }
        }
      }

      for (const { concept, sites } of PERCENT_CONCEPTS) {
        const stated = sites();
        const [first, ...rest] = stated;
        for (const other of rest) {
          if (first.printed !== other.printed) {
            failures.push(
              `${concept}: ${first.where} states ${first.printed} and ` +
                `${other.where} states ${other.printed}`,
            );
          }
        }
      }

      expect(failures, `${book}: the report states one concept twice, differently`).toEqual([]);
    });

    it(`${book}: the row the P&L ends on is labelled as the figure it carries`, async () => {
      await mountReport(book as Book);
      const section = screen.getByTestId("report-section-2-pnl");
      const rows = Array.from(section.querySelectorAll("tr")).filter(
        (tr) => tr.querySelectorAll("td").length >= 2,
      );
      const label = (rows[rows.length - 1].querySelectorAll("td")[0].textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
      // The value on that row is account 121 — the filed figure — so the
      // label has to say so. Calling it "operational" while carrying the
      // statutory anchor is the same defect as printing two numbers,
      // one level down: one concept, two names.
      expect(
        label.toLowerCase(),
        `${book}: the build-up ends on the account-121 figure under the label ` +
          `${JSON.stringify(label)}`,
      ).toContain("121");
    });
  }
});

// ── G1b — THE LAW, EXTENDED TO PROSE ──────────────────────────────────
//
// Everything above compares NUMERIC fields: a tile against a table cell,
// a percentage against a percentage. A caption disagreeing with the
// number printed directly beside it passed all of it, and one did, on
// every book, in the deliverable the owner actually reads — the printed
// board pack `buildReportHtml` writes to disk.
//
// MEASURED ON THE CURRENT TREE BEFORE THE REPAIR (2026-09-07):
//
//   book         card “Net Margin”   its own caption            the anchor
//   agras              6.3 %         "RON 14.11M bottom-line"   7,533,676.02
//   carniprod          1.4 %         "RON 5.84M bottom-line"    1,435,533.59
//   realestate      −493.7 %         "RON −30.39M bottom-line"   −801,604.14
//   retail             4.0 %         "RON 1.16M bottom-line"    3,205,212.62
//
// The card's percentage came from the engine's `net_margin`, built on
// account 121. The sentence under it interpolated the class-6/7
// reconstruction. Both were right about themselves; together they told a
// reader that a 6.3 % margin was earned on a profit 1.87× the one the
// margin divides.
//
// WHAT IT REDS ON, after the repair (TC-11): any caption re-pointed at a
// figure other than the one its metric resolved through — including a new
// caption nobody declared here, which the coverage assertion catches by
// walking every currency figure the document's prose states.
//
// WHAT IT CANNOT SEE: prose that quotes no figure (a verdict sentence
// with no number in it cannot disagree with one), and captions on ratios
// whose verdict is strong/healthy on all four books — the document only
// prints a caption block for watch/critical rows, so a concept that never
// reaches those bands on any book is never rendered and never read here.
// The coverage assertion states which concepts were actually exercised.

import {
  BOOKS as EXPORT_BOOKS,
  type Book as ExportBook,
  exportDoc,
  parsePrinted,
  proseBlocks,
  ratioCards,
  statementsFor,
} from "./exportBooks";

/** Which served fact each money-quoting caption is allowed to name. */
const CAPTION_FACTS: Array<{
  card: string;
  concept: string;
  field: string;
}> = [
  { card: "Net Margin", concept: "net profit as filed (account 121)", field: "net_income_statutory" },
  { card: "EBITDA Margin", concept: "EBITDA (statutory)", field: "ebitda_statutory" },
  { card: "Gross Margin", concept: "revenue", field: "revenue" },
];

/** The prose block the document prints for a ratio card, if any. */
function captionFor(doc: Document, card: string): string | null {
  const prefix = `${card}:`;
  const found = proseBlocks(doc).find((p) => p.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length).trim();
}

/** Every currency figure a sentence quotes, as printed. */
function quotedMoney(prose: string): string[] {
  return Array.from(prose.matchAll(/-?(?:RON|EUR|USD)\s?-?[\d,.]+\s?[KMB]?/g)).map((m) => m[0]);
}

describe("G1b — a caption resolves through the same fact as the number beside it", () => {
  const exercised = new Set<string>();

  for (const book of EXPORT_BOOKS) {
    it(`${book}: every caption quotes the fact its metric resolved`, () => {
      const doc = exportDoc(book as ExportBook);
      const pl = statementsFor(book as ExportBook).assembled_pl ?? {};
      const failures: string[] = [];

      for (const { card, concept, field } of CAPTION_FACTS) {
        const prose = captionFor(doc, card);
        if (prose === null) continue; // this row is not in a band that prints a caption
        const anchor = pl[field];
        if (typeof anchor !== "number") continue; // nothing served to compare against
        exercised.add(card);
        const quoted = quotedMoney(prose);
        if (quoted.length === 0) {
          failures.push(`${book}: caption of “${card}” quotes no figure at all: ${JSON.stringify(prose)}`);
          continue;
        }
        // Every figure the sentence states must be one of the facts this
        // caption is allowed to name; the concept's own anchor must be
        // among them.
        const values = quoted.map((q) => ({ printed: q, n: parsePrinted(q) }));
        const namesTheAnchor = values.some(
          (v) => v.n !== null && Math.abs(v.n - anchor) <= Math.max(Math.abs(anchor) * 0.005, 1),
        );
        if (!namesTheAnchor) {
          failures.push(
            `${book}: the card “${card}” resolved ${concept} = ` +
              `${anchor.toLocaleString("en-US")} (assembled_pl.${field}) and its caption states ` +
              `${values.map((v) => `${v.printed} (${v.n})`).join(", ")} — the caption names a ` +
              `different figure than the number printed beside it`,
          );
        }
      }
      expect(failures, `${book}: a caption disagrees with its own metric`).toEqual([]);
    });

    it(`${book}: no prose quotes a currency figure no declared caption owns`, () => {
      const doc = exportDoc(book as ExportBook);
      const declared = new Set(CAPTION_FACTS.map((c) => c.card));
      const cards = new Set(ratioCards(doc).map((c) => c.label));
      const stray: string[] = [];
      for (const prose of proseBlocks(doc)) {
        if (quotedMoney(prose).length === 0) continue;
        const owner = [...cards].find((label) => prose.startsWith(`${label}:`));
        if (owner === undefined || declared.has(owner)) continue;
        stray.push(`${book}: caption of “${owner}” quotes ${quotedMoney(prose).join(", ")} and is not declared in CAPTION_FACTS`);
      }
      expect(stray, `${book}: an undeclared caption states a figure`).toEqual([]);
    });
  }

  it("exercised at least one caption for each declared concept", () => {
    // Not vacuous: a caption that never renders on any of the four books
    // is never compared, and this states which were.
    expect([...exercised].sort()).toEqual(CAPTION_FACTS.map((c) => c.card).sort());
  });
});
