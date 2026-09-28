/**
 * THE CASH-BURN RULE AND THE RETIRED DUAL VIEW (owner ruling 2026-09-26).
 *
 * EBITDA includes net 711 ("Variația stocurilor de produse") and net 72x.
 * On the corpus developer (`realestate`) that makes EBITDA +550,976.12 while
 * the operations consume 29,038,838.12 of cash — the construction cost is
 * stocked through 711. `true_negative_ebitda` is REBASED on the SERVED
 * `assembled_pl.ebitda_before_stock_variation` (the one figure the ruling
 * lets differ from EBITDA, only for this finding) and worded as what it is.
 * `capitalized_own_work_disclosure` ("disclose the dual view": EBITDA with
 * 722 vs without) is RETIRED — no second EBITDA is served.
 *
 * WHAT IT REDS ON: the developer losing its cash-burn finding (the rule
 * reading the one EBITDA again); the finding calling the build-up "EBITDA";
 * the rule firing on a book that does not serve the field (undefined read
 * as negative — it did, on every book, before the guard); the dual-view
 * rule coming back on any book.
 */
import { describe, expect, it } from "vitest";

import { BOOKS, agreeingBook, metricsFor } from "./exportBooks";
import type { Book } from "./exportBooks";
import { LAST_DETECT_FOR_TEST, detectConditions } from "@/lib/recommendationRules";
import type { PeriodFacts } from "@/lib/periodFacts";
import { buildReportHtml } from "@/lib/financialExports";

function conditionsOf(book: Book) {
  const s = agreeingBook(book);
  buildReportHtml(s, { metricsByName: metricsFor(book) });
  return {
    conditions: LAST_DETECT_FOR_TEST.conditions.slice(),
    facts: LAST_DETECT_FOR_TEST.facts as PeriodFacts,
    served: (s as unknown as { assembled_pl: Record<string, unknown> }).assembled_pl,
  };
}

describe("true_negative_ebitda reads the served build-up before the stock variation", () => {
  it("keeps the developer's cash-burn finding, worded as the build-up, not as EBITDA", () => {
    const { conditions, facts, served } = conditionsOf("realestate");
    expect(served.ebitda as number).toBeGreaterThan(0);
    expect(served.ebitda_before_stock_variation as number).toBeLessThan(0);
    const burn = conditions.find((c) => c.ruleKey === "true_negative_ebitda");
    expect(burn, conditions.map((c) => c.ruleKey).join(", ")).toBeTruthy();
    expect(burn!.factsCited.ebitda_before_stock_variation).toBe(served.ebitda_before_stock_variation);
    expect(burn!.factsCited.ebitda).toBe(facts.pl.ebitda);
    expect(burn!.title).toContain("before the stock variation and own work capitalised");
    expect(burn!.title).not.toMatch(/^Statutory EBITDA/);
  });

  it.each(BOOKS.filter((b) => b !== "realestate"))(
    "%s: silent — its build-up is positive",
    (book) => {
      const { conditions } = conditionsOf(book);
      expect(conditions.map((c) => c.ruleKey)).not.toContain("true_negative_ebitda");
    },
  );

  it("stays silent when a caller serves no build-up (absent is not negative)", () => {
    const { facts } = conditionsOf("realestate");
    const without = {
      ...facts,
      pl: { ...facts.pl, ebitda_before_stock_variation: undefined as unknown as null },
    } as PeriodFacts;
    expect(detectConditions(without).map((c) => c.ruleKey)).not.toContain("true_negative_ebitda");
  });
});

describe("the dual-view disclosure is retired", () => {
  it.each(BOOKS)("%s: capitalized_own_work_disclosure never fires", (book) => {
    const { facts } = conditionsOf(book);
    // Even with a material 722 planted the rule does not exist any more.
    const planted = {
      ...facts,
      pl: { ...facts.pl, capitalized_own_work_memo: 5_000_000, rental_revenue: 100_000, revenue: 6_000_000 },
    } as PeriodFacts;
    expect(detectConditions(planted).map((c) => c.ruleKey)).not.toContain(
      "capitalized_own_work_disclosure",
    );
  });
});
