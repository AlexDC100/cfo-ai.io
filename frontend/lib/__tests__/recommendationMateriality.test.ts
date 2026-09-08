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
// ── AND WHAT WAS WRONG WITH THIS FILE ────────────────────────────────
//
// Two defects, both of which made the gate agree with the product only
// while the product stayed broken.
//
// (a) §1 read "no printed agras card claims a priority above `info`" —
//     FULL STOP. The finding the owner said was missing is a `high`, and
//     the feed that carries it (`assembled_bs.ar_intercompany`) landed on
//     2026-09-07. The moment it did, this gate red:
//
//       FAIL §1: expected [Array(1)] to deeply equal []
//         + "high: Recall RON 7,692,203 related-party receivable…"
//       FAIL §6: "…is printed but no condition reproduces it"
//
//     — i.e. the gate forbade exactly the card the wave exists to
//     produce. The claim it MEANT to make is narrower and survives: a
//     book with no debt problem may not raise its voice about DEBT.
//     §1 now says that, and §1b says the loud cards that DO print are
//     the ones the insight engine independently measured as material.
//
// (b) §3, §4, §6 and §7 graded a book the product never renders. Two
//     causes, both measured:
//
//       `computeRatios(s, { metricsByName: metricsFor(book) } as never)`
//
//     put the engine metric map in the `canonicalMargins` slot — the
//     signature is `(s, canonicalMargins?, metricsByName?)` — and the
//     `as never` suppressed the type error that would have said so. The
//     ratios that reach the rules were therefore FE fallbacks, not
//     engine canon: agras net margin 11.90% against the 6.35% the
//     document prints, carniprod ROA 4.64%/watch against 1.14%/critical,
//     and on retail interest coverage came out −0.52× against the served
//     +0.09× — a SIGN FLIP.
//
//     And `factsFor()` at the foot of the file was a ~90-line
//     hand-transcription of `financialReport.ts`'s private `safeFacts`
//     builder. Mirror doubles are this repo's documented failure mode —
//     `fake-store-hid-20-defects` records twenty defects behind green
//     tests — and this one had already drifted: it fed
//     `ebitda_to_interest: stated("interest_coverage")` where the
//     product feeds a fallback, and it could never fire the rules that
//     read a field it forgot. Both are gone. The gate now reads
//     `LAST_DETECT_FOR_TEST` — what `detectConditions` was actually
//     handed on the render that produced the document being asserted
//     over.
//
// ── WHAT THIS GATE REDS ON, AFTER THE REPAIR (TC-11) ─────────────────
//
// §1  A low-leverage, positive-below-the-line book leading with DEBT
//     advice above `info`. The message names the finding that was
//     displaced and by how much.
// §1b A loud card on agras that the insight engine does not corroborate
//     — the replacement for the old blanket "nothing above info", so
//     the volume still has to be earned.
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
//     the COMMITTED engine fixture, not restated. §4c holds the two
//     surfaces to the same MAGNITUDE, which is the open half — the
//     detector sums `ar_intercompany + ar_personnel` and the FE feed
//     carries only the first.
// §4b The recall card promising a saving larger than the interest bill,
//     a repayment larger than the debt, or a negative Debt/EBITDA as an
//     improvement. The old §4 asserted `ruleKey` and `level` only and
//     would not have caught any of the three.
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
//   `RecommendationsView` builds its facts through `periodFacts.ts`
//   instead, whose `intercompany_loans` scans account `461` alone —
//   2.0% of the agras balance. §4c names that; nothing here renders it.
// * Whether a rule that never fires on these four books is correct.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BOOKS, agreeingBook, metricsFor } from "./exportBooks";
import type { Book } from "./exportBooks";
import type { PeriodFacts } from "@/lib/periodFacts";
import {
  BANDS_FOR_TEST,
  COARSE_FOR_TEST,
  LAST_DETECT_FOR_TEST,
  MONITORING_TIERS,
  RELATED_PARTY_MAGNITUDE_LABEL,
  detectConditions,
  type DetectedCondition,
  type Severity,
} from "@/lib/recommendationRules";
import { SEVERITY_ORDER } from "@/lib/insights";
import { buildReportHtml } from "@/lib/financialExports";
import { computeRatios, type RatioBundle, type Statements } from "@/lib/financialReport";

const repoRoot = resolve(__dirname, "../../..");

/** The rules whose whole subject is the debt: its price, its covenant
 *  package, its lender. These are the cards the Agras report led with. */
const DEBT_ADVICE = [
  "refinance_opportunity",
  "covenant_monitoring_dashboard",
  "covenant_documentation_audit",
  "lender_concentration",
];

/** The ratios the DOCUMENT states — engine metric map in the metric-map
 *  parameter, which is where `buildReportHtml` puts it. */
function ratiosFor(book: Book, s: Statements): RatioBundle {
  return computeRatios(s, undefined, metricsFor(book));
}

interface PrintedRec {
  priority: string;
  title: string;
  why: string;
}

interface Run {
  /** The recommendation cards as the EXPORTED document prints them. */
  printed: PrintedRec[];
  /** The conditions `detectConditions` returned ON THAT RENDER, in the
   *  rank order it stamped — captured at the observation point inside
   *  the rule registry, not rebuilt. */
  conditions: DetectedCondition[];
  /** The facts the product handed the rules on that render. */
  facts: PeriodFacts;
}

const RUNS: Partial<Record<Book, Run>> = {};

/**
 * ONE RENDER, READ TWO WAYS.
 *
 * `buildReportHtml` is the surface the owner reads; it calls
 * `generateRecommendations`, which builds the facts privately and calls
 * `detectConditions`. Capturing both halves off the SAME call is what
 * makes this gate a reading of the product rather than a second opinion
 * about it — there is no path here that can grade a book the export did
 * not render.
 */
function run(book: Book): Run {
  const cached = RUNS[book];
  if (cached) return cached;
  const s = agreeingBook(book);
  const html = buildReportHtml(s, { metricsByName: metricsFor(book) });
  const conditions = LAST_DETECT_FOR_TEST.conditions.slice();
  const facts = LAST_DETECT_FOR_TEST.facts;
  expect(
    facts,
    `${book}: rendering the export did not reach detectConditions — the capture is empty, ` +
      `so every assertion below would be reading another book's run.`,
  ).toBeTruthy();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const printed = Array.from(doc.querySelectorAll("#sec-recs .rec")).map((el) => {
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
  const built: Run = { printed, conditions, facts: facts as PeriodFacts };
  RUNS[book] = built;
  return built;
}

/** A mutable copy of the facts the product built, for the two tests that
 *  need a counterfactual. The BASE is the product's own object; only the
 *  named operand moves, so what is being varied is visible in one line
 *  instead of buried in a re-transcription. */
function variantOf(book: Book, mutate: (f: PeriodFacts) => void): PeriodFacts {
  const copy = JSON.parse(JSON.stringify(run(book).facts)) as PeriodFacts;
  mutate(copy);
  return copy;
}

// ══════════════════════════════════════════════════════════════════════
// §1 — the Agras case: a book with no debt problem may not lead with
//      debt advice
// ══════════════════════════════════════════════════════════════════════

describe("§1 relevance", () => {
  it("agras does not lead the printed report with debt advice", () => {
    const { printed, conditions } = run("agras");
    expect(printed.length).toBeGreaterThan(0);
    const lead = conditions[0];
    const debtLead = DEBT_ADVICE.includes(lead.ruleKey) && lead.level !== "info";
    // The message must say what was pushed down, not merely that the
    // order is wrong — a rank complaint with no displaced finding named
    // is not actionable.
    const displaced = conditions
      .slice(1)
      .filter((r) => !DEBT_ADVICE.includes(r.ruleKey))
      .map((r) => `${r.ruleKey} (${r.level})`);
    expect(
      debtLead,
      `agras leads with ${lead.ruleKey} at level "${lead.level}" — debt advice on a ` +
        `book at ${String(ratiosFor("agras", agreeingBook("agras")).leverage.find((x) => x.key === "debt_to_ebitda")?.value)}× ` +
        `Debt/EBITDA whose pre-tax profit exceeds its operating EBIT. ` +
        `Displaced: ${displaced.length ? displaced.join(", ") : "nothing — the list is debt advice and nothing else"}.`,
    ).toBe(false);
  });

  it("no printed agras DEBT card claims a priority above info", () => {
    const { printed, conditions } = run("agras");
    const debtTitles = new Set(
      conditions.filter((c) => DEBT_ADVICE.includes(c.ruleKey)).map((c) => c.title),
    );
    const loud = printed.filter(
      (p) => debtTitles.has(p.title) && (p.priority === "critical" || p.priority === "high"),
    );
    expect(
      loud.map((p) => `${p.priority}: ${p.title}`),
      "agras — 60.9% equity ratio, 0.20x Debt/EBITDA, 7.43x DSCR, and net financial " +
        "INCOME — printed a debt card above `info`. This is the owner's original " +
        "complaint, and it is the only priority claim this section forbids: a loud " +
        "card about something else is what the wave exists to produce.",
    ).toEqual([]);
  });

  it("every loud agras card is one the insight engine also measured as material", () => {
    // The replacement for the old blanket ban. Volume still has to be
    // earned — but by corroboration on the same book, not by a rule that
    // no card may ever raise its voice.
    const { printed, conditions } = run("agras");
    const engineLevels = new Map(
      INSIGHTS.agras.insights.map((i) => [i.id, i.severity.level] as const),
    );
    // Which insight, if any, measures the same thing a given rule does.
    const CORROBORATED_BY: Record<string, string> = {
      intercompany_receivable_recall: "related_party_exposure",
    };
    for (const p of printed) {
      if (p.priority !== "critical" && p.priority !== "high") continue;
      const cond = conditions.find((c) => c.title === p.title);
      expect(cond, `agras: printed card "${p.title}" reproduces no condition`).toBeTruthy();
      const twin = CORROBORATED_BY[cond!.ruleKey];
      // A rule with no twin detector is exempt only when it is one of
      // the solvency rules that declare themselves unscaled.
      if (!twin) {
        expect(
          cond!.materiality.absoluteWhy,
          `agras printed "${p.title}" at ${p.priority} and nothing on the engine side ` +
            `measures the same quantity. Either map it in CORROBORATED_BY or explain ` +
            `why it is exempt from materiality scaling.`,
        ).toBeTruthy();
        continue;
      }
      expect(
        engineLevels.get(twin),
        `agras: "${p.title}" prints at ${p.priority} while the insight engine grades ` +
          `${twin} "${engineLevels.get(twin) ?? "ABSENT"}" on the same book.`,
      ).toBe(cond!.level);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// §2 — the printed order IS the ranked order
// ══════════════════════════════════════════════════════════════════════

describe("§2 the document prints the rank it computed", () => {
  it.each(BOOKS)("%s", (book) => {
    const { printed, conditions } = run(book);
    if (conditions.length === 0) {
      // THE FALLBACK IS ONE CARD, AND WHICH ONE DEPENDS ON THE PAGE.
      //
      // This asserted the exact string "info: Financials are in healthy
      // range across all dimensions" — the sentence its own comment
      // names as the owner's defect. On `carniprod` no rule fires and
      // four ratio cards on the same page grade CRITICAL (Net Margin
      // 1.4%, ROA 1.1%, ROE 1.3%, ROIC 4.6%), so that card was an
      // all-clear contradicting its own document, and pinning it here
      // made the gate red on the repair rather than on the defect.
      //
      // What the gate actually wants is unchanged and still asserted:
      // exactly ONE card, and no real finding printed beside it. What it
      // now also asserts is that the card's CLAIM matches the page —
      // an all-clear only where nothing grades below healthy.
      expect(printed.length, `${book}: the fallback printed beside real findings`).toBe(1);
      const bundle = computeRatios(agreeingBook(book), undefined, metricsFor(book));
      const belowHealthy = [
        bundle.liquidity,
        bundle.profitability,
        bundle.leverage,
        bundle.coverage,
        bundle.efficiency,
      ]
        .flat()
        .filter((r) => r.verdict === "critical" || r.verdict === "watch");
      if (belowHealthy.length === 0) {
        expect(`${printed[0].priority}: ${printed[0].title}`).toBe(
          "info: Financials are in healthy range across all dimensions",
        );
      } else {
        expect(
          printed[0].title,
          `${book}: no rule fired and ${belowHealthy.length} ratio(s) grade below healthy ` +
            `(${belowHealthy.map((r) => r.label).join("; ")}), and the fallback card reads ` +
            `"${printed[0].title}"`,
        ).toContain("No recommendation covers");
      }
      return;
    }
    expect(printed.map((p) => p.title)).toEqual(conditions.map((c) => c.title));
    expect(conditions.map((c) => c.rank)).toEqual(conditions.map((_, ix) => ix + 1));
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
    const { conditions, facts } = run("agras");
    const belowLine = facts.pl.profit_before_tax - facts.pl.ebit;
    const debt = facts.bs.bank_debt_total;
    const prize = debt * 0.005;
    const share = prize / facts.pl.net_profit;
    const floor = BANDS_FOR_TEST.annualMoney.filter((b) => b.at_least !== null).pop()!
      .at_least as number;
    expect(
      conditions.map((c) => c.ruleKey),
      `refinance_opportunity fired on agras. The book takes ${belowLine.toFixed(2)} ` +
        `below the operating line (positive = it earns more there than it pays), ` +
        `and 50bps on ${debt.toFixed(2)} of debt is ${prize.toFixed(2)}/year = ` +
        `${(share * 100).toFixed(4)}% of a ${facts.pl.net_profit.toFixed(2)} net ` +
        `profit, under the ladder's lowest graded rung of ${(floor * 100).toFixed(2)}%.`,
    ).not.toContain("refinance_opportunity");
    expect(belowLine).toBeGreaterThan(0);
    expect(share).toBeLessThan(floor);
  });

  it("fires when the prize is material, on the same book scaled down", () => {
    // Same rule, same facts the product built, one operand changed: a
    // book earning a hundredth as much makes the same saving material.
    // If this stops firing the rule has become unreachable rather than
    // well-scoped.
    const scaled = variantOf("agras", (f) => {
      f.pl.net_profit = f.pl.net_profit / 100;
      f.pl.profit_before_tax = f.pl.ebit - 1;
    });
    const ids = detectConditions(scaled).map((c) => c.ruleKey);
    expect(ids).toContain("refinance_opportunity");
  });
});

// ══════════════════════════════════════════════════════════════════════
// §4 — the displaced finding, and one exposure graded once
// ══════════════════════════════════════════════════════════════════════

const INSIGHTS = JSON.parse(
  readFileSync(resolve(repoRoot, "tests/engine/fixtures/firm/insights.json"), "utf-8"),
) as Record<
  string,
  {
    insights: {
      id: string;
      severity: { level: string; materiality: number };
      facts?: { name: string; value: number | null }[];
    }[];
  }
>;

describe("§4 the related-party exposure", () => {
  it("leads the agras list, in the document the owner reads", () => {
    const { conditions, printed } = run("agras");
    const lead = conditions[0];
    const debt = conditions.filter((c) => DEBT_ADVICE.includes(c.ruleKey));
    expect(
      lead.ruleKey,
      `with RON ${run("agras").facts.bs.intercompany_loans.toFixed(2)} of related-party ` +
        `receivables served — 32.2% of this book's equity — the list leads with ` +
        `${lead.ruleKey} (${lead.level}) and files the recall at rank ` +
        `${conditions.find((c) => c.ruleKey === "intercompany_receivable_recall")?.rank ?? "ABSENT"}. ` +
        `Debt advice present: ${debt.map((d) => `${d.ruleKey}/${d.level}`).join(", ") || "none"}.`,
    ).toBe("intercompany_receivable_recall");
    for (const d of debt) expect(d.rank).toBeGreaterThan(lead.rank);
    expect(printed[0]?.title).toBe(lead.title);
  });

  it("grades the exposure at the level the insight engine grades it", () => {
    const engine = INSIGHTS.agras.insights.find((i) => i.id === "related_party_exposure");
    expect(engine, "insights.json carries no related_party_exposure for agras").toBeTruthy();
    const recall = run("agras").conditions.find(
      (c) => c.ruleKey === "intercompany_receivable_recall",
    );
    expect(recall).toBeTruthy();
    expect(
      recall!.level,
      `one exposure, two surfaces, two verdicts: the insight engine grades ` +
        `RON ${engine!.severity.materiality} of equity "${engine!.severity.level}"; the ` +
        `recommendation grades it "${recall!.level}" at ` +
        `${((recall!.materiality.materiality ?? 0) * 100).toFixed(2)}%. They print in one document.`,
    ).toBe(engine!.severity.level);
    expect(recall!.materiality.materiality).toBeCloseTo(engine!.severity.materiality, 4);
    // The LABEL is the detector's own `magnitude_label`, so the reader
    // meets one name for one exposure across the two sections.
    expect(recall!.materiality.magnitudeLabel).toBe(RELATED_PARTY_MAGNITUDE_LABEL);
  });

  // ── THE OPEN HALF: ONE EXPOSURE, TWO ROW SETS ────────────────────
  //
  // `packs/insights/detectors.yaml` sums `related_party:
  // [ar_intercompany, ar_personnel]`; the FE feed carries
  // `assembled_bs.ar_intercompany` alone, and `assembled_bs` has no
  // `ar_personnel` key at all. On the committed carniprod fixture the
  // detector reports 148,332.17 and `ar_intercompany` is 21,923.17 —
  // 14.8% of it. The recall rule does not fire there today (the
  // intercompany slice is 0.02% of equity, below the ladder's lowest
  // rung), so nothing is currently printed twice. This gate is what
  // makes that a MEASURED absence rather than a lucky one: it reds the
  // day the rule fires on a book where the two row sets differ.
  it.each(BOOKS)("%s: if the recall prints, its magnitude is the detector's", (book) => {
    const recall = run(book).conditions.find(
      (c) => c.ruleKey === "intercompany_receivable_recall",
    );
    const engine = INSIGHTS[book]?.insights.find((i) => i.id === "related_party_exposure");
    const engineMagnitude =
      engine?.facts?.find((f) => f.name.includes("related_party") || f.name.includes("ar_intercompany"))
        ?.value ?? null;
    if (!recall) {
      expect(
        engineMagnitude === null || (run(book).facts.bs.intercompany_loans ?? 0) <= engineMagnitude,
        `${book}: the recall did not fire, yet the feed carries MORE than the detector ` +
          `measured (${run(book).facts.bs.intercompany_loans} vs ${engineMagnitude}). ` +
          `That is the two-row-set split in the other direction.`,
      ).toBe(true);
      return;
    }
    expect(
      recall.factsCited.intercompany_loans,
      `${book}: the recommendation card prints ${recall.factsCited.intercompany_loans} of ` +
        `related-party receivables while the insight card in the SAME document prints ` +
        `${engineMagnitude}. The detector sums canonical rows [ar_intercompany, ` +
        `ar_personnel]; the FE feed reads ar_intercompany alone and assembled_bs serves ` +
        `no ar_personnel. One exposure, one figure — serve the sum.`,
    ).toBeCloseTo(engineMagnitude ?? Number.NaN, 2);
  });
});

// ══════════════════════════════════════════════════════════════════════
// §4b — the prize is bounded by the balance sheet it is taken from
// ══════════════════════════════════════════════════════════════════════
//
// Measured on the agras export before this repair, with the exposure
// delivered:
//
//   interest saved   7,692,202.74 × 7.635%  = RON 587,302 / year
//   whole interest bill                       RON 277,930.35
//   new Debt/EBITDA  (3,640,202.33 − 7,692,202.74) ÷ 18,420,491.28
//                                           = −0.22× "(more bankable
//                                             territory)"
//
// The old §4 asserted `ruleKey` and `level` and would not have caught
// any of the three. This one reads the PROSE.

describe("§4b the recall card cannot promise a prize the book cannot pay", () => {
  it.each(BOOKS)("%s", (book) => {
    const { conditions, printed, facts } = run(book);
    const recall = conditions.find((c) => c.ruleKey === "intercompany_receivable_recall");
    if (!recall) return;
    const cited = recall.factsCited;
    const applied = cited.recall_applied_to_debt ?? 0;
    const saving = cited.interest_savings_if_repaid ?? 0;
    const newDte = cited.new_debt_to_ebitda ?? 0;
    expect(
      applied,
      `${book}: the card applies ${applied} to a debt stock of ${facts.bs.bank_debt_total}. ` +
        `A recall can retire at most the debt that exists.`,
    ).toBeLessThanOrEqual(facts.bs.bank_debt_total + 0.005);
    expect(
      saving,
      `${book}: the card promises ${saving} of annual interest saved against a whole ` +
        `interest bill of ${facts.pl.interest_expense}.`,
    ).toBeLessThanOrEqual(Math.max(0, facts.pl.interest_expense) + 0.005);
    expect(
      newDte,
      `${book}: the card offers a Debt/EBITDA of ${newDte} as an improvement. ` +
        `Debt cannot go below nil, so neither can the ratio built on it.`,
    ).toBeGreaterThanOrEqual(0);
    // And the PROSE — the only part a reader sees.
    const card = printed.find((p) => p.title === recall.title);
    expect(card, `${book}: the recall condition prints no card`).toBeTruthy();
    const multiples: string[] = card!.why.match(/-\d[\d,]*\.\d\d×/g) ?? [];
    const negativeRatios = multiples.filter((m) => !m.startsWith("-0.00"));
    expect(
      negativeRatios,
      `${book}: the recall card prints a negative multiple as an outcome — ` +
        `"${card!.why.slice(0, 200)}…"`,
    ).toEqual([]);
    // Where the recall exceeds the debt, the card must SAY the surplus
    // comes back as cash rather than pricing it as interest.
    if ((cited.recall_returned_as_cash ?? 0) > 0) {
      expect(
        card!.why,
        `${book}: ${cited.recall_returned_as_cash} of the recall exceeds the debt and the ` +
          `card does not say what becomes of it.`,
      ).toContain("as cash");
    }
    // And it must not send the reader to a ledger account the rule
    // cannot see. Measured on the agras classification: the balance is
    // 98.0% account 451, 2.0% account 461, and the card used to open
    // "Account 461 (Sundry debtors) holds RON 7,692,203".
    expect(
      /Account \d+/.test(card!.why),
      `${book}: the recall card names a ledger account. The rule is handed one scalar ` +
        `and no account list — on agras the balance is 451 7,536,754.90 (98.0%) and ` +
        `461.x 155,447.84 (2.0%), so any account it named would be a guess: ` +
        `"${card!.why.slice(0, 160)}…"`,
    ).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// §5 — no card claims headroom it does not have
// ══════════════════════════════════════════════════════════════════════

describe("§5 the headroom claim is measured, not asserted", () => {
  it.each(BOOKS)("%s", (book) => {
    const { printed, conditions } = run(book);
    for (const p of printed) {
      if (!p.why.includes("leaves real headroom")) continue;
      const card = conditions.find((c) => c.title === p.title);
      const consumed = card?.factsCited?.green_tier_consumed;
      expect(
        typeof consumed === "number" && consumed < 0.4,
        `${book}: "${p.title}" claims real headroom while having consumed ` +
          `${consumed === null || consumed === undefined ? "an unstated share" : `${(consumed * 100).toFixed(1)}%`} ` +
          `of the ${MONITORING_TIERS.green.dscr}x / ${MONITORING_TIERS.green.dte}x green tier. ` +
          `The sentence used to be printed unconditionally and read ` +
          `"Current DSCR 0.09x and Debt/EBITDA 126.54x have meaningful headroom" on retail.`,
      ).toBe(true);
    }
  });

  it("retail and realestate say the tier is already past, not comfortable", () => {
    for (const book of ["retail", "realestate"] as Book[]) {
      const card = run(book).printed.find((p) => p.title.includes("monitoring dashboard"));
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
    const { printed, conditions } = run(book);
    // Every printed card is a condition, and every condition is printed.
    // NOT `if (!cond) continue` — that swallow is exactly what hid
    // PLANT 5 (a card losing its ladder) while `industry` was null and
    // every scoped rule was skipped. And the condition list comes from
    // the render itself, so a card the gate cannot match is a real
    // mismatch rather than an artefact of rebuilding the facts.
    const byTitle = new Map(conditions.map((c) => [c.title, c] as const));
    for (const p of printed) {
      // The two FALLBACK cards are not conditions by construction — they
      // are what prints when the registry matched nothing — so neither
      // has a ladder to check. Both are exempt, and only these two.
      if (
        p.title === "Financials are in healthy range across all dimensions" ||
        p.title.startsWith("No recommendation covers")
      ) {
        continue;
      }
      const cond = byTitle.get(p.title);
      expect(
        cond,
        `${book}: "${p.title}" is printed but reproduces no condition from the render ` +
          `that produced it — the gate cannot check a ladder it cannot find.`,
      ).toBeTruthy();
      if (!cond) continue;
      if (cond.materiality.absoluteWhy) {
        expect(
          p.why,
          `${book}: ${cond.ruleKey} is exempt from materiality scaling and must say so`,
        ).toContain("solvency threshold");
        continue;
      }
      for (const band of cond.materiality.bands) {
        if (band.at_least === null) continue;
        const pct = (band.at_least * 100).toFixed(band.at_least < 0.01 ? 2 : 1);
        expect(
          p.why,
          `${book}: ${cond.ruleKey} printed a verdict without the rung "${band.level} >= ${pct}%" ` +
            `its own ladder was read against — a cutoff that exists only in code is a ` +
            `verdict the reader cannot check (TC-10).`,
        ).toContain(`${pct}%`);
      }
    }
    for (const c of conditions) {
      expect(
        printed.map((p) => p.title),
        `${book}: ${c.ruleKey} was detected at rank ${c.rank} and never reached the page.`,
      ).toContain(c.title);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// §7 — R4: the ladder is a share of THIS book, not an amount
// ══════════════════════════════════════════════════════════════════════

describe("§7 the same amount grades differently on books of different size", () => {
  it("a fixed related-party balance moves down the ladder as equity grows", () => {
    const held = run("agras").facts.bs.intercompany_loans;
    const grades: Record<string, string> = {};
    for (const multiple of [1, 4, 20]) {
      const scaled = variantOf("agras", (f) => {
        f.bs.intercompany_loans = held;
        f.bs.total_equity = (f.bs.total_equity ?? 0) * multiple;
        f.bs.total_assets = (f.bs.total_assets ?? 0) * multiple;
      });
      const c = detectConditions(scaled).find(
        (x) => x.ruleKey === "intercompany_receivable_recall",
      );
      grades[`x${multiple}`] = c ? c.level : "did not fire";
    }
    expect(
      new Set(Object.values(grades)).size,
      `the same RON ${held.toFixed(2)} graded ${JSON.stringify(grades)} across books of ` +
        `1x, 4x and 20x the equity — a ladder that does not move with the ` +
        `company's size is an absolute threshold wearing a percentage sign.`,
    ).toBeGreaterThan(1);
    const shown = JSON.stringify(grades);
    expect(grades["x1"], `graded ${shown}`).toBe("high");
    expect(grades["x20"], `graded ${shown}`).toBe("did not fire");
  });
});
