// D2 — AN ALL-CLEAR CONTRADICTED FOUR CARDS DOWN ITS OWN PAGE.
//
// ── WHAT WAS MEASURED, 2026-09-07 ───────────────────────────────────
//
// `overallVerdict` was derived from RECOMMENDATION PRIORITY COUNTS and
// nothing else, so a change to the rule registry alone could talk the
// cover line out of a warning. On agras, HEAD against the working tree —
// demoting one debt card PROMOTED the summary:
//
//   HEAD          "Generally healthy with 1 priority area to strengthen."
//   working tree  "Financials in healthy range across all dimensions."
//
// The same document printed Cash Ratio 0.09× CRITICAL, Quick Ratio Watch,
// Net Margin Watch, DPO Watch and "Letter grade: not reported".
// `carniprod` printed the identical all-clear over FOUR critical cards —
// Net Margin 1.4%, ROA 1.1%, ROE 1.3%, ROIC 4.6%.
//
// ── WHAT THIS GATE REDS ON, AFTER THE REPAIR (TC-11) ────────────────
//
//   · any book whose printed "Overall verdict" line reads an unqualified
//     all-clear while a ratio card, a served finding or a recommendation
//     on the SAME page grades critical — and the failure NAMES the
//     contradicting card, so the reader of the red knows where to look;
//   · the same for the softer branch: a line claiming nothing reads
//     critical while something does;
//   · a verdict that names a driver the page does not carry (the reverse
//     lie — a summary inventing a finding);
//   · the non-vacuity direction: with a clean synthetic page the all-clear
//     must still be reachable, so the fix cannot be "never say healthy".
//
// ── WHAT IT CANNOT SEE ──────────────────────────────────────────────
//
//   · whether the CALIBRATION behind a Critical badge is right. If a
//     ladder grades a 27-day DPO as distress, this gate faithfully
//     demands the cover line say so. Ladder correctness is
//     `ratioLadderHonesty`'s job.
//   · the screen. The cover line is an export-only surface.

import { describe, expect, it } from "vitest";

import { buildReportHtml } from "@/lib/financialExports";
import { computeRatios, type Statements } from "@/lib/financialReport";
import {
  BOOKS,
  exportDoc,
  insightsFixture,
  metricsFor,
  ratioCards,
  recommendationTexts,
  statementsFor,
  withInsights,
  type Book,
} from "./exportBooks";

const ALL_CLEAR = /healthy range across all dimensions/i;
const NO_CRITICAL = /No item reads critical/i;

function verdictLine(doc: Document): string {
  const found = Array.from(doc.querySelectorAll(".insight"))
    .map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim())
    .find((t) => /^Overall verdict:/i.test(t));
  if (found === undefined) {
    throw new Error("the printed document carries no “Overall verdict:” line");
  }
  return found.replace(/^Overall verdict:\s*/i, "");
}

/** Every card on the page that grades critical, named as the page names
 *  it. Read from the RENDERED document, not from the model behind it. */
function criticalCards(doc: Document): string[] {
  return ratioCards(doc)
    .filter((c) => /\bCritical\b/.test(c.meta))
    .map((c) => c.label);
}

describe("D2 — the cover line never contradicts its own page", () => {
  const shapes: Array<{ label: string; of: (b: Book) => Statements }> = [
    { label: "as captured", of: (b) => statementsFor(b) },
    { label: "with the served findings block", of: (b) => withInsights(b) as Statements },
  ];

  for (const shape of shapes) {
    for (const book of BOOKS) {
      it(`${book} (${shape.label}): no all-clear while a card grades critical`, () => {
        const doc = new DOMParser().parseFromString(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (exportDoc(book, shape.of(book) as any)).documentElement.outerHTML,
          "text/html",
        );
        const line = verdictLine(doc);
        const contradicting = criticalCards(doc);
        const criticalRecs = recommendationTexts(doc).filter((t) => /^critical\b/i.test(t));

        if (ALL_CLEAR.test(line) || NO_CRITICAL.test(line)) {
          expect(
            contradicting.concat(criticalRecs.map((t) => t.slice(0, 60))).join("; "),
            `${book}: the cover line reads "${line}" while these on the SAME page grade ` +
              `critical: ${contradicting.join("; ") || "(no ratio)"}` +
              (criticalRecs.length > 0
                ? ` and ${criticalRecs.length} critical recommendation card(s)`
                : ""),
          ).toBe("");
        }
      });
    }
  }

  for (const book of BOOKS) {
    it(`${book}: no RECOMMENDATION card claims an all-clear either`, () => {
      // The same defect one section lower. When the rule registry matched
      // nothing, `generateRecommendations` pushed a placeholder reading
      // "Financials are in healthy range across all dimensions / No
      // critical or high-priority items detected" — and on carniprod
      // that printed in a document whose own cards read Net Margin 1.4%
      // CRITICAL, ROA 1.1% CRITICAL, ROE 1.3% CRITICAL, ROIC 4.6%
      // CRITICAL. "No rule fired" is a statement about the registry.
      const doc = exportDoc(book);
      const contradicting = criticalCards(doc);
      if (contradicting.length === 0) return;
      const claiming = recommendationTexts(doc).filter((t) =>
        /healthy range across all dimensions|No critical or high-priority items/i.test(t),
      );
      expect(
        claiming.map((t) => t.slice(0, 70)).join(" | "),
        `${book}: a recommendation card claims an all-clear while these cards on the same ` +
          `page grade critical: ${contradicting.join("; ")}`,
      ).toBe("");
    });
  }

  for (const book of BOOKS) {
    it(`${book}: every driver the cover line names is a card on the page`, () => {
      const doc = exportDoc(book);
      const line = verdictLine(doc);
      // The line lists drivers after a colon, separated by "; ".
      const listed = (line.split(/:\s/).slice(1).join(": ") || "")
        .replace(/\.$/, "")
        .split("; ")
        .map((x) => x.trim())
        .filter((x) => x !== "" && !/^and \d+ more$/.test(x));
      if (listed.length === 0) return;
      const onPage = new Set([
        ...ratioCards(doc).map((c) => c.label),
        ...(insightsFixture(book).insights ?? []).map((i) => String(i.title)),
        ...recommendationTexts(doc).map((t) => t.replace(/^(critical|high|medium|info)\s+/i, "")),
      ]);
      for (const name of listed) {
        expect(
          [...onPage].some((x) => x === name || x.startsWith(name)),
          `${book}: the cover line names "${name}" and no card on the page carries that name. ` +
            `Line: "${line}"`,
        ).toBe(true);
      }
    });
  }

  it("agras: the finding severities reach the cover line", () => {
    // The captured book has no `insights` key; production serves one.
    // With it joined, the five `high` findings the engine measured on
    // this book must be visible to the summary — the half of D2 that
    // could not be measured before `withInsights` existed.
    const withBlock = withInsights("agras") as Statements;
    const line = verdictLine(exportDoc("agras", withBlock));
    const highs = insightsFixture("agras").insights.filter(
      (i) => (i.severity as { level: string }).level === "high",
    );
    expect(highs.length).toBeGreaterThan(0);
    // agras has one critical ratio, so the line is the critical branch and
    // the highs ride in the count, not the name list.
    const scanned = Number(/of (\d+) graded items/.exec(line)?.[1] ?? "0");
    const withoutBlock = Number(
      /of (\d+) graded items/.exec(verdictLine(exportDoc("agras")))?.[1] ?? "0",
    );
    expect(
      scanned - withoutBlock,
      `the findings block adds ${highs.length} findings and the cover line counted ` +
        `${scanned - withoutBlock} more items. Line: "${line}"`,
    ).toBe(insightsFixture("agras").insights.length);
  });

  it("NON-VACUITY — clearing the one critical ratio clears the critical branch", () => {
    // Built from the agras book with its only critical ratio lifted clear
    // of its own rung: cash raised until the cash ratio bands healthy.
    // Nothing else about the book is touched, so the branch change is
    // attributable to that one card.
    const base = statementsFor("agras");
    const before = [computeRatios(base, undefined, metricsFor("agras")).liquidity]
      .flat()
      .find((r) => r.key === "cash_ratio");
    expect(before?.verdict).toBe("critical");

    const lifted: Statements = {
      ...base,
      balanceSheet: { ...base.balanceSheet, cash: base.balanceSheet.cash * 40 },
      assembled_bs: { ...(base.assembled_bs ?? {}), cash: (base.assembled_bs?.cash ?? 0) * 40 },
    } as Statements;
    // Rendered with NO served metric map: `exportDoc` supplies the
    // engine's cached `cash_ratio`, which would replay the original
    // figure over the lifted statements and prove nothing.
    const line = verdictLine(
      new DOMParser().parseFromString(
        buildReportHtml(lifted, { metricsByName: {} }),
        "text/html",
      ),
    );
    expect(
      /^Action required/.test(line),
      `lifting the only critical ratio did not clear the critical branch; the cover line ` +
        `still reads "${line}"`,
    ).toBe(false);
  });

  it("NON-VACUITY — the all-clear is still reachable, and states what it scanned", () => {
    // A deliberately sound book. Not a real filing — the point is only
    // that the healthiest branch is REACHABLE, so the repair cannot be
    // "never say healthy", and that the sentence discloses its own
    // denominator so an all-clear over three graded rows is visible as
    // one.
    const sound: Statements = {
      companyName: "Sound Co",
      currency: "RON",
      periodLabel: "FY 2025",
      balanceSheet: {
        cash: 3_700_000,
        accountsReceivable: 1_300_000,
        inventory: 1_500_000,
        otherCurrentAssets: 200_000,
        propertyPlantEquipment: 6_000_000,
        intangibles: 0,
        otherNonCurrentAssets: 0,
        accountsPayable: 2_200_000,
        shortTermDebt: 300_000,
        otherCurrentLiabilities: 500_000,
        longTermDebt: 1_000_000,
        otherNonCurrentLiabilities: 0,
        shareCapital: 2_000_000,
        retainedEarnings: 5_700_000,
        otherEquity: 2_000_000,
      },
      incomeStatement: {
        revenue: 12_000_000,
        costOfGoodsSold: 6_000_000,
        operatingExpenses: 2_600_000,
        depreciationAmortization: 600_000,
        interestExpense: 120_000,
        otherIncome: 0,
        taxExpense: 430_000,
      },
      supplementary: { periodDays: 365 },
    };
    const line = verdictLine(
      new DOMParser().parseFromString(
        buildReportHtml(sound, { metricsByName: {} }),
        "text/html",
      ),
    );
    expect(line, `a sound book still could not reach the all-clear: "${line}"`).toMatch(
      ALL_CLEAR,
    );
    const scanned = Number(/all (\d+) graded items/.exec(line)?.[1] ?? "0");
    expect(
      scanned,
      `the all-clear states it scanned ${scanned} items — too few for the claim to mean ` +
        `anything. Line: "${line}"`,
    ).toBeGreaterThanOrEqual(8);
  });
});
