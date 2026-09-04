// ONE LETTER, ONE LADDER, ONE ALTMAN.
//
//     A LETTER GRADE IS MINTED BY EXACTLY ONE LADDER — THE ENGINE'S —
//     AND EVERY SURFACE THAT PRINTS ONE NAMES THE MODEL THAT MINTED IT.
//     A WORKBOOK CARRIES EXACTLY ONE ALTMAN.
//
// ─── WHY THIS FILE EXISTS AND WHAT IT REPLACES ─────────────────────────
//
// `frontend/pages/cfo/__tests__/comprehensiveReportAbsent.test.tsx` is
// the only test that renders `/report`, and it opens with
//
//     vi.mock("@/components/cfo/CreditScoreCard", () => ({
//       CreditScoreCard: () => null,
//       readCreditFromMetrics: () => null,
//     }));
//
// — it MOCKS AWAY THE COMPONENT UNDER TEST HERE. That is not a criticism
// of that file (its subject is the three statement tables and stubbing
// the card keeps its affordance counts clean); it is the reason this
// defect lived on a page that has a gate. A page test that renders the
// component as `null` proves nothing about what the component renders,
// and Section 7 was therefore ungated in a suite that looked like it
// covered the page. `absenceIsStatedNotInvented.test.tsx` does mount the
// real card, but asserts sub-score absence only — never the letter and
// never the model.
//
// SO: NOTHING IS MOCKED HERE EXCEPT THE CURRENCY STORE AND THE NETWORK.
// The real `CreditScoreCard` mounts inside the real `ComprehensiveReport`
// and §4 asserts that it did, so this file cannot rot into the same
// shape.
//
// ─── WHAT WAS MEASURED, BEFORE THE FIX ─────────────────────────────────
//
// Real corpus period (`design_review/capsule/fixtures/period-scandia-
// fy2025.json` — Scandia FY2025, a captured period, composite 24.4 /
// CC / Z" 0.22), rendered in jsdom and read out of the DOM:
//
//   engine credit envelope ABSENT
//     /dashboard Risks tab   CCC   naming model client-fallback-v1
//     /report Section 7      CC    naming NO model at all
//
//   engine RE-BANDS (letter_grade "B" shipped with its own
//   letter_grade_bands — precisely the shape F1.h already had once)
//     Risks tab · hero · workbook   B
//     /report Section 7             CC
//
// `/report`'s letter came from `compositeToGrade()` — a hardcoded copy
// of the engine's band table living inside CreditScoreCard.tsx, banding
// `calculated_metrics.credit_composite` and never reading
// `assembled_metrics.credit.letter_grade` or the envelope's own
// `letter_grade_bands`, both of which rode the SAME `/api/period/:id`
// response the page already fetched.
//
// And, read back from a real .xlsx written by `XLSX.writeFile` and
// re-parsed from its bytes, envelopes intact:
//
//   sheet "Credit & Risk"   Altman Z"-Score  0.22  30%  2.4  (no verdict)
//   sheet "Ratios"          Altman Z″-Score  0.19  Critical
//                           "…distress zone. Action required."
//
// Two numbers for one measure in one deliverable — and the DIVERGENT one
// carried the verdict words a lender reads.

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import * as XLSX from "xlsx";
import { TooltipProvider } from "@/components/ui/tooltip";

// The currency store and the network are the only doubles. Everything
// that decides or renders a letter grade is the real thing.
vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({ display: "RON", rates: { rates: {} } }),
  useAmountFormatter:
    () =>
    (v: number | null | undefined): string =>
      v === null || v === undefined ? "—" : String(Math.round(v * 100) / 100),
  useDisplayCurrency: () => "RON",
  useRates: () => ({ rates: {} }),
  CurrencyProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => null }));
const stableToast = { toast: () => undefined };
vi.mock("@/hooks/use-toast", () => ({ useToast: () => stableToast }));
vi.mock("@/hooks/useActivePeriodFallback", () => ({
  useActivePeriodFallback: () => ({ periodId: "p-scandia", status: "resolved" }),
}));

import ComprehensiveReport from "@/pages/cfo/ComprehensiveReport";
import { HeroVerdictCard, RisksPanel } from "@/pages/cfo/FinancialStatements";
import { altmanZoneOf, computeCreditScore } from "@/lib/financialValuation";
import { altmanZone } from "@/components/cfo/CreditScoreCard";
import { buildExcelWorkbook } from "@/lib/financialExports";
import type { Statements } from "@/lib/financialReport";

// ─── The real corpus period ─────────────────────────────────────────────
const CORPUS = resolve(
  __dirname,
  "../../../../design_review/capsule/fixtures/period-scandia-fy2025.json",
);
interface Corpus {
  statements: Statements;
  assembled_metrics: { credit?: Record<string, unknown>; piotroski?: Record<string, unknown> };
  metrics?: Array<{ name: string; value: number | null }>;
  line_items?: unknown[];
  period?: { period_end?: string };
}
const RAW = JSON.parse(readFileSync(CORPUS, "utf-8")) as Corpus;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** One mutable copy of the whole period. Mutations below are PLANTS. */
function freshPeriod(): Corpus {
  return clone(RAW);
}
function metricsMap(p: Corpus): Record<string, number | null> {
  const m: Record<string, number | null> = {};
  for (const x of p.metrics ?? []) m[x.name] = x.value;
  return m;
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const creditEnvelopeOf = (p: Corpus): any => p.assembled_metrics?.credit;
const piotroskiEnvelopeOf = (p: Corpus): any => p.assembled_metrics?.piotroski;

// ─── Surface A — /report Section 7, rendered ────────────────────────────

function periodResponse(p: Corpus) {
  return {
    period: {
      id: "p-scandia",
      period_end: p.period?.period_end ?? "2025-12-31",
      currency: "RON",
      source_document: { filename: "balanta.xlsx", id: "d1" },
    },
    statements: p.statements,
    metrics: p.metrics ?? [],
    alerts: [],
    recommendations: [],
    line_items: p.line_items ?? [],
    assembled_metrics: p.assembled_metrics,
  };
}

async function mountReport(p: Corpus): Promise<HTMLElement> {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => periodResponse(p) })));
  const { container } = render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/report?period=p-scandia"]}>
        <ComprehensiveReport />
      </MemoryRouter>
    </TooltipProvider>,
  );
  await screen.findByTestId("comprehensive-report");
  return container as HTMLElement;
}

/** The letter printed by /report Section 7, or null when it prints none. */
function reportLetter(root: HTMLElement): string | null {
  const el = root.querySelector('[data-testid="report-credit-letter"]');
  return el ? (el.textContent ?? "").trim() : null;
}
/** The model /report names beside its letter. */
function reportModel(root: HTMLElement): { id: string | null; text: string } {
  const el = root.querySelector('[data-testid="report-credit-model"]');
  return { id: el?.getAttribute("data-model") ?? null, text: (el?.textContent ?? "").trim() };
}

// ─── Surface B — the Risks tab, rendered ────────────────────────────────

function mountRisks(p: Corpus) {
  render(
    <RisksPanel
      statements={p.statements}
      creditEnvelope={creditEnvelopeOf(p)}
      piotroskiEnvelope={piotroskiEnvelopeOf(p)}
      metricsByName={metricsMap(p)}
    />,
  );
  return {
    letter: screen.getByTestId("credit-rating").textContent?.trim() ?? null,
    model: screen.getByTestId("credit-model").getAttribute("data-model"),
    modelText: screen.getByTestId("credit-model").textContent?.trim() ?? "",
  };
}

// ─── Surface B2 — the DASHBOARD HERO, rendered ──────────────────────────
//
// ⚠ THE ENUMERATION WAS WRONG ABOUT THIS SURFACE. Every surface census
// in this programme called the dashboard hero "CreditScoreCard, compact
// variant". It is not: it is `HeroVerdictCard` in
// frontend/pages/cfo/FinancialStatements.tsx, a projection of
// `computeCreditScore` in a different file — and `CreditScoreCard`'s
// compact branch had ZERO callers, so a dead branch was being counted as
// this surface's coverage. Nothing rendered the real hero in any test.
// It is rendered here.

function mountHero(p: Corpus) {
  const credit = computeCreditScore(
    p.statements, creditEnvelopeOf(p), piotroskiEnvelopeOf(p), metricsMap(p),
  );
  render(
    <TooltipProvider>
      <HeroVerdictCard credit={credit} companyName="Scandia Food SRL" />
    </TooltipProvider>,
  );
  const chip = screen.queryByTestId("credit-class-chip");
  const model = screen.queryByTestId("hero-credit-model");
  return {
    /** The letter the hero prints, or null when it prints no class chip.
     *  The chip reads "Credit class <letter>"; the trailing token is the
     *  letter, taken positionally rather than by stripping non-letters
     *  (which ate the "C" of "Credit"). */
    letter: chip ? ((chip.textContent ?? "").trim().split(/\s+/).pop() ?? null) : null,
    hasChip: chip !== null,
    model: model?.getAttribute("data-model") ?? null,
    modelText: (model?.textContent ?? "").trim(),
    score: screen.getByTestId("hero-verdict").getAttribute("data-score"),
  };
}

// ─── Surface C — the exported workbook, read back from its BYTES ────────
//
// Not the in-memory `WorkBook` object: the file is written with
// `XLSX.writeFile` and re-parsed from disk, because the deliverable is
// the file that leaves the building.

function workbookFromBytes(p: Corpus): XLSX.WorkBook {
  const wb = buildExcelWorkbook(p.statements, undefined, {
    credit: creditEnvelopeOf(p),
    piotroski: piotroskiEnvelopeOf(p),
    metricsByName: metricsMap(p),
  });
  const dir = mkdtempSync(join(tmpdir(), "one-letter-"));
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
/** Every row in the whole workbook that claims to be an Altman figure. */
function altmanRowsAcrossWorkbook(wb: XLSX.WorkBook): { sheet: string; cells: string[] }[] {
  const out: { sheet: string; cells: string[] }[] = [];
  for (const sheet of wb.SheetNames) {
    for (const r of rowsOf(wb, sheet)) {
      const cells = r.map((c) => String(c ?? ""));
      if (cells.some((c) => /^Altman /i.test(c))) out.push({ sheet, cells });
    }
  }
  return out;
}
/** The workbook's letter grade, from the Credit & Risk sheet. */
function workbookLetter(wb: XLSX.WorkBook): string | null {
  const row = rowsOf(wb, "Credit & Risk").find((r) => String(r[0]) === "Rating");
  return row ? String(row[1]) : null;
}
function workbookModel(wb: XLSX.WorkBook): string | null {
  const row = rowsOf(wb, "Credit & Risk").find((r) => String(r[0]) === "Scoring model");
  return row ? String(row[1]) : null;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ════════════════════════════════════════════════════════════════════════
// §0 NON-VACUITY — the intact period produces a real letter everywhere.
//
// Without this, a fix that made every surface refuse would pass every
// assertion below (TC-9: a clean result must be distinguishable from no
// subject).
// ════════════════════════════════════════════════════════════════════════

describe("§0 non-vacuity — the intact corpus period prints a real letter on all three surfaces", () => {
  it("CC, from the engine, named on each surface", async () => {
    const p = freshPeriod();

    const report = await mountReport(p);
    expect(reportLetter(report), "/report Section 7 printed no letter on an intact envelope").toBe("CC");
    const rm = reportModel(report);
    expect(rm.id).toBe("engine-canonical-v1");
    expect(rm.text).toContain(
      computeCreditScore(p.statements, creditEnvelopeOf(p), piotroskiEnvelopeOf(p), metricsMap(p))
        .modelLabel,
    );
    cleanup();

    const risks = mountRisks(p);
    expect(risks.letter).toBe("CC");
    expect(risks.model).toBe("engine-canonical-v1");
    cleanup();

    const wb = workbookFromBytes(p);
    expect(workbookLetter(wb)).toBe("CC");
    expect(workbookModel(wb)).toBe("engine-canonical-v1");
  });
});

// ════════════════════════════════════════════════════════════════════════
// §1 THE PLANT — an engine re-band must move EVERY surface together.
//
// This is the critic's own plant, and the exact shape F1.h had: the
// engine re-bands, emitting a new `letter_grade` alongside the new
// `letter_grade_bands`. Before the fix this printed B on the Risks tab,
// the hero and the workbook, and CC on /report.
// ════════════════════════════════════════════════════════════════════════

/** Re-band the engine: composite 24.4 now falls in "B". */
function reBanded(): Corpus {
  const p = freshPeriod();
  const c = creditEnvelopeOf(p);
  c.letter_grade = "B";
  c.letter_grade_bands = [
    { min: 90, grade: "AAA" }, { min: 70, grade: "AA" }, { min: 50, grade: "A" },
    { min: 40, grade: "BBB" }, { min: 30, grade: "BB" }, { min: 20, grade: "B" },
    { min: 10, grade: "CCC" }, { min: 0, grade: "CC" },
  ];
  return p;
}

describe("§1 an engine re-band moves every surface together", () => {
  it("/report Section 7 follows the engine to B", async () => {
    const report = await mountReport(reBanded());
    expect(
      reportLetter(report),
      "the engine re-banded and /report kept minting its own letter — a frontend band ladder is a second model by another name",
    ).toBe("B");
  });

  it("the Risks tab and the workbook agree with it, and the reader every other surface shares says B", async () => {
    const p = reBanded();
    const risks = mountRisks(p);
    expect(risks.letter).toBe("B");
    cleanup();
    expect(workbookLetter(workbookFromBytes(p))).toBe("B");
    // The hero card, the compact score chip and the Risks tab all print
    // `computeCreditScore(...).rating`. Asserting the shared reader here
    // covers those surfaces at their source.
    const shared = computeCreditScore(
      p.statements, creditEnvelopeOf(p), piotroskiEnvelopeOf(p), metricsMap(p),
    );
    expect(shared.rating).toBe("B");
    expect(shared.model).toBe("engine-canonical-v1");
  });

  it("the DASHBOARD HERO follows it too — the surface the census misnamed", () => {
    const hero = mountHero(reBanded());
    expect(hero.letter, "the hero printed a letter the engine did not mint").toBe("B");
    expect(hero.model).toBe("engine-canonical-v1");
    expect(hero.score).toBe("24.4");
  });

  it("all four surfaces print the SAME letter — stated as one comparison, not four", async () => {
    const p = reBanded();
    const report = await mountReport(p);
    const a = reportLetter(report);
    cleanup();
    const b = mountRisks(p).letter;
    cleanup();
    const d = mountHero(p).letter;
    cleanup();
    const c = workbookLetter(workbookFromBytes(p));
    expect(
      new Set([a, b, c, d]).size,
      `four surfaces, letters ${JSON.stringify({ report: a, risks: b, workbook: c, hero: d })}`,
    ).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §2 THE REPLICA LADDER IS GONE — proved behaviourally, not by grep.
//
// The engine sends bands and NO `letter_grade`. The ladder maps the same
// composite (24.4) to a grade the deleted frontend table could never
// produce for it. If any replica survived anywhere, this prints CC.
// ════════════════════════════════════════════════════════════════════════

describe("§2 the letter comes from the envelope's own ladder, never from a frontend table", () => {
  it("engine bands with no letter_grade — /report bands with THEM", async () => {
    const p = freshPeriod();
    const c = creditEnvelopeOf(p);
    delete c.letter_grade;
    c.letter_grade_bands = [{ min: 0, grade: "AAA" }];
    const report = await mountReport(p);
    expect(
      reportLetter(report),
      "the engine's ladder said AAA for this composite and the page printed something else — a frontend ladder is still alive",
    ).toBe("AAA");
    expect(
      report.querySelector('[data-testid="report-credit-letter"]')?.getAttribute("data-letter-source"),
    ).toBe("letter_grade_bands");
    // And the shared reader — the Risks tab, the hero, the workbook —
    // reaches the same letter off the same field.
    const shared = computeCreditScore(p.statements, c, piotroskiEnvelopeOf(p), metricsMap(p));
    expect(shared.rating).toBe("AAA");
  });

  it("no ladder and no letter — the page refuses rather than inventing one", async () => {
    const p = freshPeriod();
    const c = creditEnvelopeOf(p);
    delete c.letter_grade;
    delete c.letter_grade_bands;
    const report = await mountReport(p);
    expect(reportLetter(report), "a letter appeared with no engine ladder behind it").toBeNull();
    // Non-vacuity for this case: the composite is still on screen, so
    // this is a refused LETTER, not a refused card.
    expect(report.querySelector('[data-testid="credit-score-card"]')?.textContent ?? "").toContain("24");
  });
});

// ════════════════════════════════════════════════════════════════════════
// §3 NO ENGINE ENVELOPE — and the engine has TWO MOUTHS.
//
// ⚠ THIS SECTION USED TO ENCODE THE F2 DEFECT AS ITS LAW. It deleted
// `assembled_metrics.credit`, left `calculated_metrics` untouched, and
// then ASSERTED that the two surfaces answer differently — /report
// showing the engine's 24.4 while naming no model, the Risks tab showing
// the client fallback's CCC / 36 off different arithmetic. That is one
// period with two composites and two Altmans, and it is the exact
// production shape CLAUDE.md §14 documents.
//
// `calculated_metrics` IS the engine speaking. Deleting only the envelope
// leaves an engine period with no LETTER (the rows carry no band ladder)
// — the settled rule "a missing engine envelope invents no letter
// anywhere" — and both surfaces now say that, in the same words, off the
// same number. Reaching the OTHER model takes silencing both mouths.
// ════════════════════════════════════════════════════════════════════════

describe("§3 with no engine credit envelope, no surface prints an unnamed letter", () => {
  it("envelope deleted, metric rows intact: BOTH surfaces stay on the engine, and neither mints a letter", async () => {
    const p = freshPeriod();
    delete p.assembled_metrics.credit;

    const report = await mountReport(p);
    expect(
      reportLetter(report),
      "/report printed a letter with no engine ladder behind it",
    ).toBeNull();
    const m = reportModel(report);
    expect(
      m.id,
      "/report showed the engine's own composite while naming no model at all",
    ).toBe("engine-canonical-v1");
    expect(m.text.toLowerCase()).toContain("not reported");
    // Non-vacuity: the composite really is on screen, so this is a
    // refused LETTER and not a refused card.
    expect(report.querySelector('[data-testid="credit-score-card"]')?.textContent ?? "").toContain("24");
    cleanup();

    const risks = mountRisks(p);
    expect(
      risks.model,
      "the Risks tab answered with the OTHER model off metric rows the engine wrote",
    ).toBe("engine-canonical-v1");
    const shared = computeCreditScore(
      p.statements, creditEnvelopeOf(p), piotroskiEnvelopeOf(p), metricsMap(p),
    );
    expect(shared.score, "one period, one composite").toBe(24.4);
    expect(shared.altman.score, "one period, one Altman").toBe(0.22);
    expect(shared.rating, "no ladder reached this period, so no letter").toBeNull();
    cleanup();

    // …and the hero shows the SAME composite, names the SAME model, and
    // does not claim a credit class it has no letter for.
    const hero = mountHero(p);
    expect(hero.score).toBe("24.4");
    expect(hero.model).toBe("engine-canonical-v1");
    expect(
      hero.hasChip,
      "the hero rendered a credit-class chip with no letter to put in it",
    ).toBe(false);
  });

  it("both mouths silent — THEN the fallback runs, and says so", () => {
    const p = freshPeriod();
    delete p.assembled_metrics.credit;
    delete p.assembled_metrics.piotroski;
    const risks = mountRisks({ ...p, metrics: [] });
    expect(risks.letter).toBe("CCC");
    expect(risks.model).toBe("client-fallback-v1");
    expect(risks.modelText).toBe(computeCreditScore(p.statements).modelLabel);
    expect(risks.modelText, "the fallback must say WHY it is the fallback").toContain(
      "no engine credit envelope",
    );
  });

  it("THE LAW, as one statement: a letter on any surface implies a named model", async () => {
    for (const withEnvelope of [true, false]) {
      const p = freshPeriod();
      if (!withEnvelope) delete p.assembled_metrics.credit;

      const report = await mountReport(p);
      if (reportLetter(report) !== null) {
        expect(reportModel(report).id, "/report printed a letter naming no model").not.toBe("none");
        expect(reportModel(report).text.length).toBeGreaterThan(0);
      }
      cleanup();

      const risks = mountRisks(p);
      if (risks.letter && risks.letter !== "—") {
        expect(risks.model, "the Risks tab printed a letter naming no model").toBeTruthy();
        expect(risks.modelText.length).toBeGreaterThan(0);
      }
      cleanup();

      const wb = workbookFromBytes(p);
      const letter = workbookLetter(wb);
      if (letter && letter !== "not reported") {
        expect(workbookModel(wb), "the workbook printed a letter naming no model").toBeTruthy();
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// §4 THE MOCK SHAPE — this file must never become the thing it replaces.
// ════════════════════════════════════════════════════════════════════════

describe("§4 the component under test is really mounted", () => {
  it("/report renders the real CreditScoreCard, not a stub", async () => {
    const report = await mountReport(freshPeriod());
    const card = report.querySelector('[data-testid="credit-score-card"]');
    expect(card, "the card did not render — a page test that mocks it away proves nothing about it").not.toBeNull();
    // Real internals, not an empty shell: the seven weighted component
    // rows and the Z" breakdown only exist in the real component.
    expect(card!.textContent).toContain("Component breakdown");
    expect(card!.textContent).toContain("X1 (working capital)");
    expect(report.querySelector('[data-testid="report-credit-ladder"]')).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// §5 ONE ALTMAN PER WORKBOOK.
//
// Gathered from EVERY sheet of the re-parsed file, so a third Altman
// added to a fourth sheet tomorrow reds this too.
// ════════════════════════════════════════════════════════════════════════

describe("§5 one workbook, one Altman", () => {
  /** Every distinct (label, value) an Altman row claims in the file. */
  function altmanClaims(p: Corpus) {
    const rows = altmanRowsAcrossWorkbook(workbookFromBytes(p));
    return {
      rows,
      labels: new Set(rows.map((r) => r.cells.find((c) => /^Altman /i.test(c))!)),
      values: new Set(
        rows.map((r) => {
          const i = r.cells.findIndex((c) => /^Altman /i.test(c));
          return r.cells[i + 1];
        }),
      ),
    };
  }

  it("non-vacuity: the intact period really does put an Altman on two sheets", () => {
    const { rows } = altmanClaims(freshPeriod());
    expect(rows.length, "no Altman row in the workbook at all — this gate would be vacuous").toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r) => r.sheet)).size).toBeGreaterThanOrEqual(2);
  });

  it("one value and one name — intact", () => {
    const { values, labels, rows } = altmanClaims(freshPeriod());
    // The VALUE first: two numbers for one measure is the defect, and
    // the name is the thing that made them easy to mistake for two
    // measures. Asserting the name first would mask the number in the
    // failure message.
    expect(
      values.size,
      `two numbers for one measure in one deliverable: ${JSON.stringify([...values])} — ${JSON.stringify(rows, null, 1)}`,
    ).toBe(1);
    expect(
      labels.size,
      `one measure under two names: ${JSON.stringify([...labels])}`,
    ).toBe(1);
  });

  it("THE PLANT that defeats a half-fix: delete only calculated_metrics.altman_z_score", () => {
    // Threading the engine metric map into `computeRatios` makes the two
    // sheets agree ONLY while this row happens to arrive. Measured
    // before the sheets were made one reader: the map threaded through,
    // this row deleted, the workbook split 0.22 / 0.19 again.
    const p = freshPeriod();
    p.metrics = (p.metrics ?? []).filter((m) => m.name !== "altman_z_score");
    const { values, rows } = altmanClaims(p);
    expect(values.size, `${JSON.stringify(rows, null, 1)}`).toBe(1);
  });

  it("…and with no engine credit envelope at all", () => {
    const p = freshPeriod();
    delete p.assembled_metrics.credit;
    const { values, labels, rows } = altmanClaims(p);
    expect(values.size, `${JSON.stringify(rows, null, 1)}`).toBe(1);
    expect(labels.size).toBe(1);
  });

  it("the verdict words sit beside the authority's own number, on both sheets", () => {
    const wb = workbookFromBytes(freshPeriod());
    const rows = altmanRowsAcrossWorkbook(wb);
    for (const r of rows) {
      expect(
        r.cells.some((c) => /zone/i.test(c)),
        `the Altman row on "${r.sheet}" carries a number with no verdict, while another sheet carried the verdict: ${JSON.stringify(r.cells)}`,
      ).toBe(true);
    }
  });

  it("the workbook's Altman is the same figure the Risks tab renders", () => {
    const p = freshPeriod();
    const onScreen = screen; // rendered below
    mountRisks(p);
    const domScore = onScreen.getByTestId("altman-score").textContent?.trim();
    cleanup();
    const { values } = altmanClaims(p);
    expect([...values][0], "the file and the screen print different Altmans").toBe(domScore);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §6 ONE ALTMAN INSIDE THE READER ITSELF.
//
// The engine emits the Z" TWICE — as `calculated_metrics.altman_z_score`
// and as `assembled_metrics.credit.altman_z_score` — and
// `computeCreditScore` used to prefer a DIFFERENT one in two places:
// `altmanFromEngine` takes calculated_metrics first (its result is the
// `altman-score` and the zone chip on the Risks tab), while the
// component row took `e.altman_z_score` first. Measured with the two
// inputs split (envelope 0.22, metrics 3.09):
//
//     Risks tab  altman-score 3.09   zone chip  SAFE
//     same panel, component row 0.22  read  "Distress zone — immediate
//                                            action required"
//
// One panel, one company, a SAFE chip beside a DISTRESS sentence. In
// production both fields come off the same engine row, so this is a
// latent split — which is exactly the kind that survives a corpus sweep
// and surfaces the day one emission path changes.
// ════════════════════════════════════════════════════════════════════════

describe("§6 the two engine Altman emissions can disagree — the reader must not", () => {
  /** Split the engine's two Z" emissions against each other. */
  function splitAltman(): Corpus {
    const p = freshPeriod();
    p.metrics = [...(p.metrics ?? [])];
    const i = p.metrics.findIndex((m) => m.name === "altman_z_score");
    if (i >= 0) p.metrics[i] = { name: "altman_z_score", value: 3.09 };
    else p.metrics.push({ name: "altman_z_score", value: 3.09 });
    creditEnvelopeOf(p).altman_z_score = 0.22;
    return p;
  }

  it("the headline score, the zone chip and the component row are one figure", () => {
    const p = splitAltman();
    mountRisks(p);
    const headline = screen.getByTestId("altman-score").textContent?.trim();
    const zone = screen.getByTestId("altman-zone").getAttribute("data-zone");
    // The component table's Altman row: label cell, then the value cell.
    const row = Array.from(document.querySelectorAll("tr")).find((tr) =>
      /^Altman /.test(tr.querySelector("td")?.textContent?.trim() ?? ""),
    );
    expect(row, "no Altman component row rendered").toBeTruthy();
    const cells = Array.from(row!.querySelectorAll("td")).map((td) => td.textContent?.trim() ?? "");
    expect(
      cells[1],
      `the panel's headline Z" is ${headline} and its own component row says ${cells[1]}`,
    ).toBe(headline);
    // …and the sentence beside the number agrees with the chip above it.
    const read = cells[4] ?? "";
    const sentenceZone = /Safe zone/.test(read) ? "safe" : /Grey zone/.test(read) ? "grey" : "distress";
    expect(
      sentenceZone,
      `the zone chip says ${zone} and the row's sentence says ${JSON.stringify(read)}`,
    ).toBe(zone);
  });

  // ── §6b THE ZONE LADDER, WHICH WAS ALSO DUPLICATED ────────────────
  //
  // `CreditScoreCard.altmanZone()` banded with `>=` while `zoneFor` —
  // the mapping behind the Risks tab chip, the component sentence and
  // the workbook — bands with `>`, per Appendix A. Measured across the
  // boundaries: at Z" = 2.60 exactly /report said "Safe" and the Risks
  // tab said "Grey"; at 1.10 exactly /report said "Grey" and the Risks
  // tab said "Distress". A boundary is where the word matters most.
  it("§6b the zone word is one word — swept across both thresholds", () => {
    for (const z of [3.0, 2.61, 2.6, 2.5999, 1.11, 1.1, 1.0999, 0.22]) {
      const card = altmanZone(z);
      const reader = altmanZoneOf(z);
      expect(card, `Z" = ${z}: /report says "${card}", every other surface says "${reader}"`).toBe(reader);
    }
    // Non-vacuity: the sweep really does cross both bands.
    expect(new Set([3.0, 2.6, 1.1, 0.22].map(altmanZone)).size).toBe(3);
  });

  it("and the workbook carries that same one figure", () => {
    const p = splitAltman();
    mountRisks(p);
    const headline = screen.getByTestId("altman-score").textContent?.trim();
    cleanup();
    const rows = altmanRowsAcrossWorkbook(workbookFromBytes(p));
    const values = new Set(
      rows.map((r) => {
        const i = r.cells.findIndex((c) => /^Altman /i.test(c));
        return r.cells[i + 1];
      }),
    );
    expect(values.size, `${JSON.stringify(rows, null, 1)}`).toBe(1);
    expect([...values][0]).toBe(headline);
  });
});
