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
//
// AND IT COMPUTES NO RATIO FOR THE PRIOR PERIOD. The band-movement block
// (the headline: which ratios crossed a band, up and down) and the two
// ratio tiles (equity ratio, net debt / EBITDA) are READ off the engine's
// served two-period table, `statements.comparatives.ratios`, in the served
// order. Nothing here subtracts, ranks, re-bands or divides: the engine
// did all four, once, for every surface.

import type { CreditScoreResult } from "./financialValuation";
import {
  ALTMAN_RATIO_KEY,
  deriveTotals,
  formatRatio,
  printedRungCrossed,
  printRatioCompareRow,
  priorRatioAbsence,
  ratioRankBasisSentence,
  ratioRowAbsence,
  RATIO_CMP_EXPORT_LOCALE,
  servedMovableRows,
  servedRatioComparison,
  servedRatioLabel,
  type PrintedRatioCompare,
  type Ratio,
  type RatioBundle,
  type RatioVerdict,
  type Statements,
} from "./financialReport";
import { reasonText, type RatioCompareRow, type RatioDisplayUnit } from "./ratioTable";
import {
  buildComparatives,
  comparativeLine,
  type ComparativeLine,
  type Comparatives,
} from "./reportComparatives";
import { readInsights, summaryInsights, type Insight } from "./insights";
import { equityRefusalOf, netIncomeRefusalOf, readServedOneEbitda } from "./servedOneEbitda";

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
  unit: ComparativeLine["unit"] | RatioDisplayUnit;
  value: number | null;
  /** The money line's comparative. Null on a ratio tile, which reads
   *  `ratio` instead — a ratio's prior is never a subtraction here. */
  line: ComparativeLine | null;
  /** Present on a RATIO tile: the served two-period row it prints, or the
   *  stated reason there is none. */
  ratio: SummaryRatioTile | null;
  /** The ENGINE's reason when it refused this figure (EBITDA, the net
   *  result, total equity short by it) — English, the board document's
   *  language. The tile prints "refused — <reason>", never "not
   *  reported" (critic round 3, 2026-09-28). */
  refusal?: string | null;
}

export interface SummaryRatioTile {
  /** The served census key the tile reads. */
  servedKey: string;
  row: RatioCompareRow | null;
  printed: PrintedRatioCompare | null;
  /** Present iff `row` is null — why the tile has no served comparison. */
  absence: string | null;
}

/** The tiles that are RATIOS, and the served census key each one reads.
 *  Their current figure, prior, change and band all come off the served
 *  two-period row; `reportComparatives.ts` carries money lines only. */
export const SUMMARY_RATIO_TILES: Readonly<Record<string, { servedKey: string; label: string; unit: RatioDisplayUnit }>> = {
  equity_ratio: { servedKey: "equity_ratio", label: "Equity ratio", unit: "pct" },
  net_debt_ebitda: { servedKey: "net_debt_to_ebitda", label: "Net debt / EBITDA", unit: "x" },
};

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

// ── 5. THE HEADLINE: WHICH RATIOS CROSSED A BAND ──────────────────────

export type CrossingFindingStatus = "surfaced" | "demoted" | "absent";

export interface BandCrossingEntry {
  key: string;
  label: string;
  direction: "up" | "down";
  /** The served row. A served list naming a key the served table carries
   *  no row for is not an entry: it is stated in `unlisted`. */
  row: RatioCompareRow;
  printed: PrintedRatioCompare;
  /** "Strong rung at 2×" — the served rung, printed in the row's unit. */
  rung: string | null;
  /** The served finding row for this crossing (a surfaced seven-element
   *  finding or the check row it demoted to), matched on `finding_id`. */
  findingId: string | null;
  findingStatus: CrossingFindingStatus;
  /** The surfaced finding's own title, verbatim. */
  findingTitle: string | null;
  /** A demoted finding's missing contract elements, verbatim. */
  findingMissing: string[];
}

export interface BandMovementNote {
  key: string;
  label: string;
  reason: string;
}

export interface SummaryBandMovements {
  /** FALSE when no served two-period table reached this document. */
  available: boolean;
  /** Present iff `available` is false — why there is no block. */
  absence: string | null;
  currentLabel: string | null;
  priorLabel: string | null;
  /** The served ranking rule, as its sentence. TC-10. */
  basis: string | null;
  /** In served rank order. */
  improved: BandCrossingEntry[];
  deteriorated: BandCrossingEntry[];
  /** Non-vacuous: present iff the list is empty while a table was served. */
  improvedAbsence: string | null;
  deterioratedAbsence: string | null;
  unchanged: Array<{ key: string; label: string; band: string }>;
  notComparable: BandMovementNote[];
  refused: BandMovementNote[];
  /** Keys a served list names with no row in the served table. */
  unlisted: string[];
  /** The served count the four lists partition (`coverage.both_sides`). */
  bothSides: number | null;
}

/**
 * The band-movement headline, read off the served table. Lists keep the
 * SERVED order (the engine ranked them: rungs crossed, distance past the
 * rung as a share of the band, materiality, key). Every crossing is listed
 * whether its finding surfaced or demoted — a demotion never shrinks the
 * list, it is stated on the entry.
 */
export function buildBandMovements(
  s: Statements,
  ratios: RatioBundle | null,
  altmanLabel: string | null,
): SummaryBandMovements {
  const cmp = servedRatioComparison(s);
  if (!cmp) {
    return {
      available: false,
      absence: priorRatioAbsence(s),
      currentLabel: null,
      priorLabel: null,
      basis: null,
      improved: [],
      deteriorated: [],
      improvedAbsence: null,
      deterioratedAbsence: null,
      unchanged: [],
      notComparable: [],
      refused: [],
      unlisted: [],
      bothSides: null,
    };
  }
  const rows = new Map(servedMovableRows(cmp).map((row) => [row.key, row]));
  const label = (key: string): string => servedRatioLabel(key, ratios, altmanLabel);
  const bm = cmp.band_movements;
  const findings = new Map<string, Record<string, unknown>>();
  for (const f of bm?.findings ?? []) {
    const id = (f as { finding_id?: unknown }).finding_id;
    if (typeof id === "string") findings.set(id, f);
  }
  const unlisted: string[] = [];
  const entries = (keys: readonly string[], direction: "up" | "down"): BandCrossingEntry[] => {
    const out: BandCrossingEntry[] = [];
    for (const key of keys) {
      const row = rows.get(key);
      if (!row) {
        unlisted.push(key);
        continue;
      }
      const f = row.finding_id === null ? undefined : findings.get(row.finding_id);
      const surfaced = f !== undefined && (f as { surfaced?: unknown }).surfaced === true;
      const title = f === undefined ? null : (f as { title?: unknown }).title;
      const missing = f === undefined ? [] : (f as { missing_elements?: unknown }).missing_elements;
      out.push({
        key,
        label: label(key),
        direction,
        row,
        printed: printRatioCompareRow(row, label(key)),
        rung: printedRungCrossed(row),
        findingId: row.finding_id,
        findingStatus: f === undefined ? "absent" : surfaced ? "surfaced" : "demoted",
        findingTitle: surfaced && typeof title === "string" ? title : null,
        findingMissing: Array.isArray(missing) ? missing.filter((m): m is string => typeof m === "string") : [],
      });
    }
    return out;
  };
  const improved = entries(bm?.improved ?? [], "up");
  const deteriorated = entries(bm?.deteriorated ?? [], "down");
  const between = `between ${cmp.prior_label} and ${cmp.current_label}`;
  return {
    available: true,
    absence: null,
    currentLabel: cmp.current_label,
    priorLabel: cmp.prior_label,
    basis: ratioRankBasisSentence(cmp),
    improved,
    deteriorated,
    improvedAbsence: improved.length > 0 ? null : `no ratio moved up a band ${between}`,
    deterioratedAbsence: deteriorated.length > 0 ? null : `no ratio moved down a band ${between}`,
    unchanged: (bm?.unchanged ?? []).map((u) => {
      const row = rows.get(u.key);
      return {
        key: u.key,
        label: label(u.key),
        band: row ? printRatioCompareRow(row, label(u.key)).bandNow : String(u.band ?? ""),
      };
    }),
    notComparable: (bm?.not_comparable ?? []).map((n) => ({
      key: n.key,
      label: label(n.key),
      reason: reasonText(n.reason_code, RATIO_CMP_EXPORT_LOCALE),
    })),
    refused: (bm?.refused ?? []).map((n) => ({
      key: n.key,
      label: label(n.key),
      reason: reasonText(n.reason_code, RATIO_CMP_EXPORT_LOCALE),
    })),
    unlisted,
    bothSides: typeof cmp.coverage?.both_sides === "number" ? cmp.coverage.both_sides : null,
  };
}

// ── THE WHOLE MODEL ───────────────────────────────────────────────────

export interface ExecutiveSummary {
  /** The headline: ratios that crossed a band against the prior period. */
  bandMovements: SummaryBandMovements;
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

/**
 * @param currentOverrides the figures the DOCUMENT already prints for these
 *   concepts, keyed by comparative-line key. Forwarded verbatim to
 *   `buildComparatives`, whose own contract explains why: the renderer
 *   resolves EBITDA and net income through `pick(assembled_pl.*,
 *   deriveTotals.*)`, and on the committed books those two readings are not
 *   the same number — agras nets 7,533,676.02 as filed against 14,106,102.03
 *   reconstructed. A tile built from `deriveTotals` alone would print the
 *   second figure under the same name as the card printing the first, one
 *   screen apart. That is R1, in a KPI strip.
 */
export function buildExecutiveSummary(
  s: Statements,
  ratios: RatioBundle,
  credit: CreditScoreResult,
  extraRatios: Ratio[] = [],
  limit = 5,
  currentOverrides: Readonly<Record<string, number | null>> = {},
): ExecutiveSummary {
  const comparatives = buildComparatives(s, currentOverrides);
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
  const altmanLabel = extraRatios.find((x) => x.key === ALTMAN_RATIO_KEY)?.label ?? null;
  const cmp = servedRatioComparison(s);
  const servedRows = new Map(cmp ? servedMovableRows(cmp).map((row) => [row.key, row]) : []);
  // The engine's refusals a tile with no figure is refused BY.
  const oneEbitda = readServedOneEbitda(s.assembled_pl);
  const ebitdaRefusal = oneEbitda && oneEbitda.ebitda === null ? oneEbitda.refusal?.text.en ?? null : null;
  const tileRefusal: Record<string, string | null> = {
    ebitda: ebitdaRefusal,
    net_income: netIncomeRefusalOf(s)?.text.en ?? null,
    equity_ratio: equityRefusalOf(s)?.text.en ?? null,
    net_debt_ebitda: ebitdaRefusal,
  };
  const tiles: SummaryTile[] = SUMMARY_TILE_KEYS.map((key) => {
    const ratioSpec = SUMMARY_RATIO_TILES[key];
    if (ratioSpec) {
      const row = servedRows.get(ratioSpec.servedKey) ?? null;
      // The caller's resolved figure; else the current row the ratio cards
      // print (equity ratio has one; net debt / EBITDA has none).
      const override = Object.prototype.hasOwnProperty.call(currentOverrides, key)
        ? currentOverrides[key]
        : (allRatios(ratios, extraRatios).find((x) => x.key === key)?.value ?? null);
      return {
        key,
        refusal: tileRefusal[key] ?? null,
        label: ratioSpec.label,
        unit: row ? (row.display_unit as RatioDisplayUnit) : ratioSpec.unit,
        // The served full-precision value when a table was served; the
        // caller's resolved figure otherwise. Never a division here.
        value: row ? row.current.value : override,
        line: null,
        ratio: {
          servedKey: ratioSpec.servedKey,
          row,
          printed: row ? printRatioCompareRow(row, ratioSpec.label) : null,
          absence: row
            ? null
            : cmp
              ? ratioRowAbsence(ratioSpec.label)
              : priorRatioAbsence(s),
        },
      };
    }
    const line = comparativeLine(comparatives, key);
    return {
      key,
      refusal: tileRefusal[key] ?? null,
      label: line?.label ?? key,
      unit: line?.unit ?? "money",
      value: line ? line.current : null,
      line,
      ratio: null,
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
    bandMovements: buildBandMovements(s, ratios, altmanLabel),
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
