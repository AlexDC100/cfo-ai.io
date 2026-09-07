// N4 — RECOMMENDATIONS MUST POINT AT WHAT IS BIG ON *THIS* BOOK.
//
// ── WHAT WAS WRONG, MEASURED ─────────────────────────────────────────
//
// The owner's deployed Agras report shipped exactly two recommendations
// and both were about debt:
//
//   [high] covenant_monitoring_dashboard  "Stand up monthly DSCR /
//          Debt-EBITDA monitoring dashboard"
//   [info] refinance_opportunity          "Refinance window: DSCR 7.43×
//          and adjusted Debt/EBITDA 0.20× are bankable"
//
// on a book at 0.20× Debt/EBITDA and a 60.9% equity ratio whose pre-tax
// profit is ABOVE its operating EBIT — it takes more below the operating
// line than it gives up. The entire quantified prize was RON 18,201 a
// year: 0.24% of a RON 7,533,676 net profit. Meanwhile the insight
// engine, on the same book, measures RON 7,692,203 of related-party
// receivables (32.2% of equity) and a 70.4%-depreciated asset base, and
// the recommendation list said nothing about either.
//
// Three separate causes, all pinned below:
//   1. `severity` was a CONSTANT per rule, so nothing computed how big a
//      finding was on the subject company and a process errand could
//      outrank a third of equity.
//   2. Triggers were absolute RON floors ("bank_debt_total >= 3,000,000",
//      "ic <= 500_000") — the same number for a 39M book and a 400M one.
//   3. The monitoring card asserted "have meaningful headroom"
//      unconditionally, which was FALSE on two of the four committed
//      books and contradicted a CRITICAL card in the same list.
//
// ── WHAT THIS GATE REDS ON, AFTER THE REPAIR (TC-11) ─────────────────
//
// §1  A low-leverage, positive-below-the-line book leading with debt
//     advice above `info`. The message names the finding that was
//     displaced and by how much.
// §2  The rendered order in the EXPORT disagreeing with `condition.rank`
//     — i.e. a caller's re-sort undoing the materiality order. This is
//     the reason the gate reads the printed document (TC-7) and not
//     `detectConditions`' return value: `financialReport.ts` and
//     `RecommendationsView.tsx` BOTH re-sort with `severityRank`, and a
//     coarse comparator that stopped being monotonic would reorder the
//     list only in the render.
// §3  `refinance_opportunity` returning on a book whose prize does not
//     clear the ladder's own lowest graded rung, or whose result below
//     the operating line is positive.
// §4  The related-party exposure being graded differently here and in
//     the insight engine (R1 across surfaces): the level is read out of
//     the COMMITTED engine fixture, not restated.
// §5  A card claiming headroom it does not have.
// §6  A graded card that does not print its ladder (TC-10).
// §7  The ladder ceasing to be materiality-scaled — the same magnitude
//     on a book scaled 10× must grade lower.
//
// ── WHAT IT CANNOT SEE ───────────────────────────────────────────────
//
// * Whether the cutoffs are WISE. It pins that the bands in `BANDS` are
//   the bands applied and printed; it cannot tell you 2% of net profit
//   is the right place to put `high` for an annual saving.
// * The live `usePeriodFacts` path. It exercises the report entry point
//   (`generateRecommendations`), which is the surface the owner reads.
// * §4's fact plumbing. `financialReport.ts` feeds
//   `intercompany_loans: pick(ab.intercompany_loans, 0)` while the
//   envelope names that balance `ar_intercompany`, so the exported
//   report receives 0 and the recall rule cannot fire from it at all.
//   That single-line repair is in a file this lane may not edit; §4
//   therefore delivers the fact explicitly and pins what the ranking
//   does WITH it. Until the feed is fixed the finding is absent from the
//   printed report, and no gate here can make it appear.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BOOKS, agreeingBook, metricsFor, workspaceKeys } from "./exportBooks";
import type { Book } from "./exportBooks";
import type { PeriodFacts } from "@/lib/periodFacts";
import {
  BANDS_FOR_TEST,
  COARSE_FOR_TEST,
  MONITORING_TIERS,
  detectConditions,
  type Severity,
} from "@/lib/recommendationRules";
import { SEVERITY_ORDER } from "@/lib/insights";
import {
  buildReportHtml,
} from "@/lib/financialExports";
import {
  computeRatios,
  generateRecommendations,
  type RatioBundle,
  type Statements,
} from "@/lib/financialReport";

const repoRoot = resolve(__dirname, "../../..");

/** The rules whose whole subject is the debt: its price, its covenant
 *  package, its lender. These are the cards the Agras report led with. */
const DEBT_ADVICE = [
  "refinance_opportunity",
  "covenant_monitoring_dashboard",
  "covenant_documentation_audit",
  "lender_concentration",
];

function ratiosFor(book: Book, s: Statements): RatioBundle {
  return computeRatios(s, { metricsByName: metricsFor(book) } as never);
}

function recsFor(book: Book) {
  const s = agreeingBook(book);
  return generateRecommendations(s, ratiosFor(book, s));
}

/** The recommendation cards as the EXPORTED document prints them. */
function printedRecs(book: Book): { priority: string; title: string; why: string }[] {
  const s = agreeingBook(book);
  const html = buildReportHtml(s, { metricsByName: metricsFor(book) });
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll("#sec-recs .rec")).map((el) => {
    const pill = el.querySelector(".priority-pill");
    const h4 = el.querySelector("h4");
    const why = Array.from(el.querySelectorAll("p")).find((p) =>
      (p.textContent ?? "").startsWith("Why:"),
    );
    const title = (h4?.textContent ?? "").replace(pill?.textContent ?? "", "").trim();
    return {
      priority: (pill?.textContent ?? "").trim(),
      title,
      why: (why?.textContent ?? "").trim(),
    };
  });
}

// ══════════════════════════════════════════════════════════════════════
// §1 — the Agras case: a book with no debt problem may not lead with
//      debt advice
// ══════════════════════════════════════════════════════════════════════

describe("§1 relevance", () => {
  it("agras does not lead the printed report with debt advice", () => {
    const printed = printedRecs("agras");
    expect(printed.length).toBeGreaterThan(0);
    const conditions = recsFor("agras");
    const lead = conditions[0];
    const debtLead = DEBT_ADVICE.includes(lead.id) && lead.priority !== "info";
    // The message must say what was pushed down, not merely that the
    // order is wrong — a rank complaint with no displaced finding named
    // is not actionable.
    const displaced = conditions
      .slice(1)
      .filter((r) => !DEBT_ADVICE.includes(r.id))
      .map((r) => `${r.id} (${r.priority})`);
    expect(
      debtLead,
      `agras leads with ${lead.id} at priority "${lead.priority}" — debt advice on a ` +
        `book at ${String(ratiosFor("agras", agreeingBook("agras")).leverage.find((x) => x.key === "debt_to_ebitda")?.value)}× ` +
        `Debt/EBITDA whose pre-tax profit exceeds its operating EBIT. ` +
        `Displaced: ${displaced.length ? displaced.join(", ") : "nothing — the list is debt advice and nothing else"}.`,
    ).toBe(false);
  });

  it("no printed agras card claims a priority above info", () => {
    const printed = printedRecs("agras");
    const loud = printed.filter((p) => p.priority === "critical" || p.priority === "high");
    expect(
      loud.map((p) => `${p.priority}: ${p.title}`),
      "agras — 60.9% equity ratio, 0.20x Debt/EBITDA, 7.43x DSCR — printed a " +
        "card above `info`. Every rule that fires on this book is now graded " +
        "against a figure taken from the book itself; a loud card means one " +
        "of them found something genuinely large, or a ladder slipped.",
    ).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// §2 — the printed order IS the ranked order
// ══════════════════════════════════════════════════════════════════════

describe("§2 the document prints the rank it computed", () => {
  it.each(BOOKS)("%s", (book) => {
    const conditions = recsFor(book);
    const printed = printedRecs(book);
    expect(printed.map((p) => p.title)).toEqual(conditions.map((c) => c.title));
  });

  it("severityRank stays monotonic in the graded level, over the WHOLE enum", () => {
    // `financialReport.ts` and `RecommendationsView.tsx` both re-sort the
    // returned list with `severityRank`. That re-sort is harmless ONLY
    // while the coarse severity is non-decreasing in the fine level; the
    // moment it is not, the render silently reorders.
    //
    // This used to walk the conditions the four committed books happen
    // to produce, and PLANT 7 — mapping `high` to "info" — RED NOTHING,
    // because no fixture book emits a `high` and a `medium` in the same
    // list. A property of the mapping has to be checked on the mapping,
    // not on whatever four books happen to exercise.
    const coarse = { critical: 0, attention: 1, info: 2 } as Record<Severity, number>;
    for (let i = 0; i < SEVERITY_ORDER.length; i += 1) {
      for (let j = i + 1; j < SEVERITY_ORDER.length; j += 1) {
        const finer = SEVERITY_ORDER[i];
        const coarser = SEVERITY_ORDER[j];
        expect(
          coarse[COARSE_FOR_TEST[finer]] <= coarse[COARSE_FOR_TEST[coarser]],
          `"${finer}" collapses to "${COARSE_FOR_TEST[finer]}" while the LOWER ` +
            `level "${coarser}" collapses to "${COARSE_FOR_TEST[coarser]}". Both ` +
            `call sites re-sort on the coarse value, so a ${finer} finding would ` +
            `be rendered BELOW a ${coarser} one.`,
        ).toBe(true);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// §3 — the refinance trigger
// ══════════════════════════════════════════════════════════════════════

describe("§3 refinance_opportunity", () => {
  it("stays silent on agras, and the two reasons are both measurable", () => {
    const s = agreeingBook("agras");
    const ap = (s as unknown as { assembled_pl: Record<string, number> }).assembled_pl;
    const belowLine = ap.pretax - ap.operating_ebit;
    const debt = (s as unknown as { assembled_bs: Record<string, number> }).assembled_bs.total_debt;
    const prize = debt * 0.005;
    const share = prize / ap.net_income_statutory;
    const floor = BANDS_FOR_TEST.annualMoney.filter((b) => b.at_least !== null).pop()!
      .at_least as number;
    expect(
      recsFor("agras").map((r) => r.id),
      `refinance_opportunity fired on agras. The book takes ${belowLine.toFixed(2)} ` +
        `below the operating line (positive = it earns more there than it pays), ` +
        `and 50bps on ${debt.toFixed(2)} of debt is ${prize.toFixed(2)}/year = ` +
        `${(share * 100).toFixed(4)}% of a ${ap.net_income_statutory.toFixed(2)} net ` +
        `profit, under the ladder's lowest graded rung of ${(floor * 100).toFixed(2)}%.`,
    ).not.toContain("refinance_opportunity");
    expect(belowLine).toBeGreaterThan(0);
    expect(share).toBeLessThan(floor);
  });

  it("fires when the prize is material, on the same book scaled down", () => {
    // Same rule, same book, one operand changed: a book earning a
    // hundredth as much makes the same saving material. If this stops
    // firing the rule has become unreachable rather than well-scoped.
    const f = factsFor("agras");
    const scaled = {
      ...f,
      pl: { ...f.pl, net_profit: f.pl.net_profit / 100, profit_before_tax: f.pl.ebit - 1 },
    };
    const ids = detectConditions(scaled as never).map((c) => c.ruleKey);
    expect(ids).toContain("refinance_opportunity");
  });
});

// ══════════════════════════════════════════════════════════════════════
// §4 — the displaced finding, and one exposure graded once
// ══════════════════════════════════════════════════════════════════════

const INSIGHTS = JSON.parse(
  readFileSync(resolve(repoRoot, "tests/engine/fixtures/firm/insights.json"), "utf-8"),
) as Record<string, { insights: { id: string; severity: { level: string; materiality: number } }[] }>;

describe("§4 the related-party exposure", () => {
  it("leads the agras list once the fact reaches the rules", () => {
    const f = factsFor("agras");
    // 7,692,202.74 — the figure the engine's canonical rows carry as
    // `ar_intercompany`, and the figure the insight engine reports.
    const withFact = { ...f, bs: { ...f.bs, intercompany_loans: 7692202.74 } };
    const conditions = detectConditions(withFact as never);
    const lead = conditions[0];
    const debt = conditions.filter((c) => DEBT_ADVICE.includes(c.ruleKey));
    expect(
      lead.ruleKey,
      `with RON 7,692,202.74 of related-party receivables delivered — 32.2% of ` +
        `this book's equity — the list leads with ${lead.ruleKey} ` +
        `(${lead.level}) and files the recall at rank ` +
        `${conditions.find((c) => c.ruleKey === "intercompany_receivable_recall")?.rank ?? "ABSENT"}. ` +
        `Debt advice present: ${debt.map((d) => `${d.ruleKey}/${d.level}`).join(", ") || "none"}.`,
    ).toBe("intercompany_receivable_recall");
    for (const d of debt) {
      expect(d.rank).toBeGreaterThan(lead.rank);
    }
  });

  it("grades the exposure at the level the insight engine grades it", () => {
    const engine = INSIGHTS.agras.insights.find((i) => i.id === "related_party_exposure");
    expect(engine, "insights.json carries no related_party_exposure for agras").toBeTruthy();
    const f = factsFor("agras");
    const withFact = { ...f, bs: { ...f.bs, intercompany_loans: 7692202.74 } };
    const recall = detectConditions(withFact as never).find(
      (c) => c.ruleKey === "intercompany_receivable_recall",
    );
    expect(recall).toBeTruthy();
    expect(
      recall!.level,
      `one exposure, two surfaces, two verdicts: the insight engine grades ` +
        `RON 7,692,202.74 "${engine!.severity.level}" at ` +
        `${(engine!.severity.materiality * 100).toFixed(2)}% of equity; the ` +
        `recommendation grades it "${recall!.level}" at ` +
        `${((recall!.materiality.materiality ?? 0) * 100).toFixed(2)}%. They print in one document.`,
    ).toBe(engine!.severity.level);
    expect(recall!.materiality.materiality).toBeCloseTo(engine!.severity.materiality, 4);
  });
});

// ══════════════════════════════════════════════════════════════════════
// §5 — no card claims headroom it does not have
// ══════════════════════════════════════════════════════════════════════

describe("§5 the headroom claim is measured, not asserted", () => {
  it.each(BOOKS)("%s", (book) => {
    for (const printed of printedRecs(book)) {
      if (!printed.why.includes("leaves real headroom")) continue;
      const conditions = recsFor(book);
      const card = conditions.find((c) => c.title === printed.title);
      const consumed = card?.factsCited?.green_tier_consumed;
      expect(
        typeof consumed === "number" && consumed < 0.4,
        `${book}: "${printed.title}" claims real headroom while having consumed ` +
          `${consumed === null || consumed === undefined ? "an unstated share" : `${(consumed * 100).toFixed(1)}%`} ` +
          `of the ${MONITORING_TIERS.green.dscr}x / ${MONITORING_TIERS.green.dte}x green tier. ` +
          `The sentence used to be printed unconditionally and read ` +
          `"Current DSCR 0.09x and Debt/EBITDA 126.54x have meaningful headroom" on retail.`,
      ).toBe(true);
    }
  });

  it("retail and realestate say the tier is already past, not comfortable", () => {
    for (const book of ["retail", "realestate"] as Book[]) {
      const card = printedRecs(book).find((p) =>
        p.title.includes("monitoring dashboard"),
      );
      expect(card, `${book} prints no monitoring card`).toBeTruthy();
      expect(card!.why).not.toContain("meaningful headroom");
      expect(card!.why).toContain("already AT or past that tier");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// §6 — TC-10: the cutoffs render from the table the verdict read
// ══════════════════════════════════════════════════════════════════════

describe("§6 every graded card prints its ladder", () => {
  it.each(BOOKS)("%s", (book) => {
    for (const c of recsFor(book)) {
      if (c.id === "all_healthy") continue;
      const card = printedRecs(book).find((p) => p.title === c.title);
      expect(card, `${book}: ${c.id} is not in the printed document`).toBeTruthy();
      // NOT `if (!cond) continue` — that swallow is exactly what hid
      // PLANT 5 (a card losing its ladder) while `industry` was null and
      // every scoped rule was skipped. A card in the document that this
      // gate cannot find a condition for is itself the failure.
      const cond = detectConditions(factsFor(book)).find((x) => x.title === c.title);
      expect(
        cond,
        `${book}: "${c.title}" is printed but no condition reproduces it — the ` +
          `gate cannot check a ladder it cannot find.`,
      ).toBeTruthy();
      if (!cond) continue;
      if (cond.materiality.absoluteWhy) {
        expect(
          card!.why,
          `${book}: ${c.id} is exempt from materiality scaling and must say so`,
        ).toContain("solvency threshold");
        continue;
      }
      for (const band of cond.materiality.bands) {
        if (band.at_least === null) continue;
        const pct = (band.at_least * 100).toFixed(band.at_least < 0.01 ? 2 : 1);
        expect(
          card!.why,
          `${book}: ${c.id} printed a verdict without the rung "${band.level} >= ${pct}%" ` +
            `its own ladder was read against — a cutoff that exists only in code is a ` +
            `verdict the reader cannot check (TC-10).`,
        ).toContain(`${pct}%`);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// §7 — R4: the ladder is a share of THIS book, not an amount
// ══════════════════════════════════════════════════════════════════════

describe("§7 the same amount grades differently on books of different size", () => {
  it("a fixed related-party balance moves down the ladder as equity grows", () => {
    const f = factsFor("agras");
    const grades: Record<string, string> = {};
    for (const multiple of [1, 4, 20]) {
      const scaled = {
        ...f,
        bs: {
          ...f.bs,
          intercompany_loans: 7692202.74,
          total_equity: (f.bs.total_equity ?? 0) * multiple,
          total_assets: (f.bs.total_assets ?? 0) * multiple,
        },
      };
      const c = detectConditions(scaled as never).find(
        (x) => x.ruleKey === "intercompany_receivable_recall",
      );
      grades[`x${multiple}`] = c ? c.level : "did not fire";
    }
    expect(
      new Set(Object.values(grades)).size,
      `the same RON 7,692,202.74 graded ${JSON.stringify(grades)} across books of ` +
        `1x, 4x and 20x the equity — a ladder that does not move with the ` +
        `company's size is an absolute threshold wearing a percentage sign.`,
    ).toBeGreaterThan(1);
    const shown = JSON.stringify(grades);
    expect(grades["x1"], `graded ${shown}`).toBe("high");
    expect(grades["x20"], `graded ${shown}`).toBe("did not fire");
  });
});

// ─── the facts the report entry point builds, reused by the direct
//     condition tests above so they exercise the same shape the printed
//     document does ────────────────────────────────────────────────────

/** The fact shape `financialReport.ts` hands the rule registry. Typed
 *  rather than `unknown`, so a rule reading a field this gate does not
 *  build is a TYPE error here instead of an `undefined` at run time. */
type GateFacts = PeriodFacts;

const CAPTURED: Partial<Record<Book, GateFacts>> = {};

function factsFor(book: Book): GateFacts {
  if (!CAPTURED[book]) {
    const s = agreeingBook(book);
    // `generateRecommendations` builds the facts privately; capture them
    // by asking it to detect on this book and reading back what the
    // rules were given. There is no public builder, so the shape is
    // reconstructed from the same served fields it uses.
    const ap = (s as unknown as { assembled_pl: Record<string, number> }).assembled_pl ?? {};
    const ab = (s as unknown as { assembled_bs: Record<string, number> }).assembled_bs ?? {};
    const r = ratiosFor(book, s);
    const stated = (key: string): number | null => {
      const found = [r.liquidity, r.profitability, r.leverage, r.coverage, r.efficiency]
        .flat()
        .find((x) => x.key === key);
      return found === undefined ? null : found.value;
    };
    CAPTURED[book] = {
      period_id: "gate",
      computed_at: "1970-01-01T00:00:00.000Z",
      pipeline_version: "gate",
      entity: s.companyName ?? "Entity",
      // THE KEY THE REPORT ENTRY POINT RESOLVES, not null. With `null`
      // every `industries:`-scoped rule is skipped, so §6 quietly
      // skipped the only card that carries one (`property_tax_
      // reassessment_provision` on realestate) and PLANT 5 — dropping
      // that card's ladder — red NOTHING. Found by planting, not by
      // reading.
      industry: workspaceKeys(book).agrees,
      currency: s.currency,
      pl: {
        rental_revenue: ap.revenue ?? 0,
        capitalized_own_work_memo: ap.capitalized_own_work_memo ?? 0,
        revenue: ap.total_operating_revenue ?? ap.revenue ?? 0,
        ebitda: ap.ebitda_statutory ?? 0,
        ebitda_excl_capitalized: ap.ebitda_statutory ?? 0,
        depreciation: ap.depreciation ?? 0,
        ebit: ap.operating_ebit ?? 0,
        interest_expense: ap.interest_expense ?? 0,
        fx_result: 0,
        dividend_income: ap.financial_income_other ?? 0,
        net_financial_result: 0,
        profit_before_tax: ap.pretax ?? 0,
        tax: ap.tax ?? 0,
        net_profit: ap.net_income_statutory ?? 0,
      },
      bs: {
        cash: ab.cash ?? 0,
        cash_fx_component: 0,
        ar_net: ab.ar_net ?? 0,
        intercompany_loans: ab.intercompany_loans ?? 0,
        prepayments: 0,
        current_assets: ab.total_current_assets ?? null,
        investment_property_net: ab.ppe_net ?? 0,
        ppe_net: ab.ppe_net ?? 0,
        non_current_assets: ab.total_non_current_assets ?? null,
        total_assets: ab.total_assets ?? null,
        suppliers: ab.ap ?? 0,
        dividends_payable: ab.ap_dividends ?? 0,
        bank_debt_total: ab.total_debt ?? 0,
        short_term_liabilities: ab.total_current_liabilities ?? null,
        total_liabilities: ab.total_liabilities ?? null,
        share_capital: ab.share_capital ?? 0,
        revaluation_reserves: ab.revaluation_reserves ?? 0,
        retained_earnings: ab.retained_earnings ?? 0,
        current_year_pnl: ab.current_year_pnl ?? 0,
        total_equity: ab.total_equity ?? null,
        bs_balance_check: ab.bs_balance_delta ?? null,
        lender_concentration_pct: undefined,
        tenant_concentration_pct: undefined,
      },
      cf: {
        cash_from_operating: 0,
        cash_used_in_investing: 0,
        cash_used_in_financing: 0,
        net_change_in_cash: 0,
        opening_cash: 0,
        closing_cash: ab.cash ?? 0,
        drift: 0,
        dividends_declared_but_unpaid: false,
      },
      ratios: {
        current_ratio: stated("current_ratio") ?? 0,
        quick_ratio: stated("quick_ratio") ?? 0,
        cash_ratio: stated("cash_ratio") ?? 0,
        debt_to_equity: stated("debt_to_equity") ?? 0,
        debt_to_assets: 0,
        equity_ratio: (stated("equity_ratio") ?? 0) / 100,
        interest_coverage_ebit: 0,
        ebitda_to_interest: stated("interest_coverage") ?? 0,
        dscr: stated("dscr") ?? 0,
        debt_to_ebitda: stated("debt_to_ebitda") ?? 0,
        debt_to_ebitda_adjusted: stated("debt_to_ebitda") ?? 0,
        ebitda_margin_gross: 0,
        ebitda_margin_clean: 0,
        net_margin: (stated("net_margin") ?? 0) / 100,
        roe: 0,
        roa: 0,
        property_yield: 0,
      },
      valuation: {
        primary_method: "asset_based",
        primary_value: 0,
        confidence: "low",
        industry_key: null,
        ev_ebitda_p50: null,
      },
      audit: { bs_balance_check: null, has_line_items: false, industry_classified: false },
    } as GateFacts;
  }
  return CAPTURED[book] as GateFacts;
}
