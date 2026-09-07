// executiveSummary.ts — THE MODEL BEHIND PAGE ONE.
//
// This file computes; it does not render. Lane C draws it. Everything
// here is derived from figures the served envelope already carries and
// from the SAME ladder objects the badges were banded with — nothing is
// re-typed, and no threshold appears as prose (TC-10).
//
// Four blocks, in the order a reader needs them:
//
//   1. verdict          the grade, and the two or three facts that
//                       produced it — each naming its own figure, so
//                       "why A−" is checkable without leaving page one
//   2. tiles            six KPIs, each with its variance vs prior and
//                       vs last year, or the stated absence of one
//   3. insights         the top five from lane A's block, unchanged
//   4. wouldChange      the rungs this company is nearest to crossing,
//                       each with the distance in the ratio's own unit,
//                       computed from `Ratio.ladder` — the object
//                       `verdictFromBands` read to set the badge
//
// WHAT IT WILL NOT DO. It states no threshold it did not read off a
// ladder; it prints no variance for a period nobody supplied; and it
// draws no verdict fact from a ratio whose own value is absent.

import type { CreditScoreResult } from "./financialValuation";
import {
  deriveTotals,
  formatRatio,
  type Ratio,
  type RatioBundle,
  type RatioVerdict,
  type Statements,
} from "./financialReport";
import {
  buildComparatives,
  comparativeLine,
  type ComparativeLine,
  type Comparatives,
} from "./reportComparatives";
import { readInsights, summaryInsights, type Insight } from "./insights";

// ── 1. THE VERDICT AND WHAT PRODUCED IT ───────────────────────────────

export interface VerdictFact {
  /** The ratio / component this fact is, so a reader can find it below. */
  key: string;
  label: string;
  /** As the document prints it elsewhere — `formatRatio`, never a second
   *  spelling. */
  printed: string;
  verdict: RatioVerdict;
  /** The band sentence the card carries, verbatim. */
  benchmark: string;
}

export interface SummaryVerdict {
  /** The engine's letter, or null. NEVER a frontend default ladder. */
  letter: string | null;
  score: number | null;
  /** The model that said it, so the letter is attributable. */
  model: string;
  /** Present iff `letter` is null — why there is no grade. */
  unavailable: string | null;
  /** The two or three strongest facts behind the grade, worst first:
   *  a reader who disagrees with the letter needs the evidence, and the
   *  evidence that matters is what is failing. */
  facts: VerdictFact[];
}

// ── 2. THE TILES ──────────────────────────────────────────────────────

export interface SummaryTile {
  key: string;
  label: string;
  unit: ComparativeLine["unit"];
  value: number | null;
  line: ComparativeLine | null;
}

/** SIX, and these six. The methodology's eight headline KPIs
 *  (CLAUDE.md Appendix A §4) minus ROE and Altman Z″ — both of which
 *  already have a card of their own further down the same document, and
 *  a tile repeating one would be the same concept printed twice on one
 *  page. */
export const SUMMARY_TILE_KEYS = [
  "revenue",
  "ebitda",
  "net_income",
  "total_assets",
  "equity_ratio",
  "net_debt_ebitda",
] as const;

// ── 4. WHAT WOULD CHANGE THE VERDICT ──────────────────────────────────

export type LadderMove = "improve" | "deteriorate";

export interface ThresholdDistance {
  ratioKey: string;
  ratioLabel: string;
  /** The band this company would cross into. */
  toVerdict: RatioVerdict;
  /** Which way crossing it goes. */
  move: LadderMove;
  /** The rung itself, off the ladder the badge was banded with. */
  threshold: number;
  /** The company's own value. */
  value: number;
  /** |value − threshold| in the ratio's own unit. */
  distance: number;
  /** distance ÷ |threshold| × 100 — how CLOSE, scaled to the rung, so a
   *  0.05× gap on a 1.25× covenant ranks above a 4× gap on a 60-day
   *  ladder. This is the ordering key and it is stated. */
  distancePctOfThreshold: number | null;
  unit: Ratio["unit"];
}

// ── THE WHOLE MODEL ───────────────────────────────────────────────────

export interface ExecutiveSummary {
  verdict: SummaryVerdict;
  tiles: SummaryTile[];
  comparatives: Comparatives;
  insights: Insight[];
  /** Present iff `insights` is empty — why page one carries none. */
  insightsAbsence: string | null;
  wouldChange: ThresholdDistance[];
  /** Present iff `wouldChange` is empty. */
  wouldChangeAbsence: string | null;
  /** The ordering rule, printed, so the ranking is checkable. TC-10. */
  wouldChangeBasis: string;
}

const WOULD_CHANGE_BASIS =
  "Ranked by distance to the rung as a share of the rung itself, nearest first — " +
  "computed from the same band object each badge above was decided by.";

function allRatios(r: RatioBundle, extra: Ratio[]): Ratio[] {
  return [...r.liquidity, ...r.profitability, ...r.leverage, ...r.coverage, ...r.efficiency, ...extra];
}

/** Rank order for "which facts explain the grade": worst first. A
 *  reader looking at a B does not need to be told what is strong. */
const VERDICT_RANK: Record<RatioVerdict, number> = {
  critical: 0,
  watch: 1,
  healthy: 2,
  strong: 3,
  // Neither of the two refusals is evidence for or against a grade, so
  // both sort last and are filtered out before they can be quoted.
  ungraded: 4,
  unknown: 5,
};

/** Every rung of one ratio's ladder, as a crossing this company could
 *  make, with the distance to it. A ratio with no `ladder` contributes
 *  NOTHING — including every sector-calibrated row under a disputed
 *  sector, whose cutoff the card refused to print and which must not
 *  reappear here. */
function distancesFor(r: Ratio): ThresholdDistance[] {
  if (r.value === null || !Number.isFinite(r.value)) return [];
  if (r.ladder === undefined) return [];
  if (r.verdict === "unknown" || r.verdict === "ungraded") return [];
  const { bands, higherIsBetter } = r.ladder;
  const rungs: Array<[RatioVerdict, number | undefined]> = [
    ["strong", bands.strong],
    ["healthy", bands.healthy],
    ["watch", bands.watch],
    ["critical", bands.critical],
  ];
  const out: ThresholdDistance[] = [];
  for (const [toVerdict, threshold] of rungs) {
    if (threshold === undefined || !Number.isFinite(threshold)) continue;
    if (toVerdict === r.verdict) continue;
    const distance = Math.abs(r.value - threshold);
    // Which side of the rung the company is on decides whether crossing
    // it is an improvement or a slip — `higherIsBetter` is the only
    // thing that knows, which is why the ladder carries it.
    const above = r.value >= threshold;
    const move: LadderMove = higherIsBetter === above ? "deteriorate" : "improve";
    out.push({
      ratioKey: r.key,
      ratioLabel: r.label,
      toVerdict,
      move,
      threshold,
      value: r.value,
      distance,
      distancePctOfThreshold: threshold === 0 ? null : (distance / Math.abs(threshold)) * 100,
      unit: r.unit,
    });
  }
  return out;
}

export function buildExecutiveSummary(
  s: Statements,
  ratios: RatioBundle,
  credit: CreditScoreResult,
  extraRatios: Ratio[] = [],
  limit = 5,
): ExecutiveSummary {
  const comparatives = buildComparatives(s);
  const totals = deriveTotals(s);

  // ── verdict ────────────────────────────────────────────────────────
  const graded = allRatios(ratios, extraRatios)
    .filter((r) => r.value !== null && r.verdict !== "unknown" && r.verdict !== "ungraded")
    .sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]);
  const facts: VerdictFact[] = graded.slice(0, 3).map((r) => ({
    key: r.key,
    label: r.label,
    printed: formatRatio(r),
    verdict: r.verdict,
    benchmark: r.benchmark,
  }));

  const verdict: SummaryVerdict = {
    letter: credit.rating,
    score: credit.score,
    model: credit.modelLabel,
    unavailable:
      credit.rating === null
        ? "the engine emitted no letter grade and no band ladder to derive one from for this period"
        : null,
    facts,
  };

  // ── tiles ──────────────────────────────────────────────────────────
  const tileValue = (key: string): number | null => {
    const line = comparativeLine(comparatives, key);
    if (line) return line.current;
    return null;
  };
  const tiles: SummaryTile[] = SUMMARY_TILE_KEYS.map((key) => {
    const line = comparativeLine(comparatives, key);
    return {
      key,
      label: line?.label ?? key,
      unit: line?.unit ?? "money",
      value: tileValue(key),
      line,
    };
  });
  void totals;

  // ── insights (lane A's block, unchanged) ───────────────────────────
  const block = readInsights(s);
  const insights = block === null ? [] : summaryInsights(block);

  // ── what would change the verdict ──────────────────────────────────
  const wouldChange = allRatios(ratios, extraRatios)
    .flatMap(distancesFor)
    .sort((a, b) => {
      const ap = a.distancePctOfThreshold;
      const bp = b.distancePctOfThreshold;
      // A rung of zero has no scale to be near; it sorts last rather
      // than pretending to be infinitely close or infinitely far.
      if (ap === null && bp === null) return 0;
      if (ap === null) return 1;
      if (bp === null) return -1;
      return ap - bp;
    })
    .slice(0, limit);

  return {
    verdict,
    tiles,
    comparatives,
    insights,
    insightsAbsence:
      insights.length > 0
        ? null
        : block === null
          ? "this period was served without an insights block"
          : "the insight detectors ran and none rose to the summary",
    wouldChange,
    wouldChangeAbsence:
      wouldChange.length > 0
        ? null
        : "no ratio on this book carries both a value and a band ladder, so there is no rung to measure a distance to",
    wouldChangeBasis: WOULD_CHANGE_BASIS,
  };
}
