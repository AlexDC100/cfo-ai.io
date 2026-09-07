// recommendationRules.ts — deterministic detection over PeriodFacts.
//
// Each rule examines the canonical facts and (when triggered) returns a
// structured finding: its own MATERIALITY on this book (a magnitude, the
// company figure it is a share of, and the ladder that share is read
// against) plus factsCited. It does NOT state its own severity — the
// registry grades it, ranks it and stamps the rank. The narrative
// (rationale + actions + what-not-to-do) is generated separately — by
// the Opus 4.7 backend pipeline call, or by static labels for offline
// rendering. Same facts always produce the same set of conditions, in
// the same order.
//
// CRITICAL: every numeric trigger reads STATUTORY values explicitly. The
// "true_*" rules (true_negative_ebitda, true_debt_service_distress,
// true_distress_altman) only fire when the underlying condition is real
// on statutory inputs — they would have stayed silent on EEI because
// statutory EBITDA is +RON 2.13M, DSCR is 1.43×, Altman Z" is ~3.15
// (safe zone). The old rules fired on operational EBITDA / Altman Z'
// and produced the "engage restructuring advisor / waive covenant"
// recommendations that would have damaged the Patria relationship.
//
// Industry-aware: each rule can declare `industries: [...]` to scope.
// CRE-only rules (tenant_concentration_renewal) won't fire for SaaS
// companies; generic-business rules (intercompany_receivable_recall)
// fire across industries when the condition is met.

import type { PeriodFacts } from "./periodFacts";
import type { InsightLevel, InsightSeverityBand } from "./insights";
import { SEVERITY_LABEL, SEVERITY_ORDER } from "./insights";

export type Severity = "info" | "attention" | "critical";

export interface DetectedCondition {
  ruleKey: string;
  severity: Severity;
  /** The graded level, on the SAME five-rung ladder the insight engine
   *  uses (`InsightLevel` in `insights.ts`). `severity` above is this
   *  value collapsed onto the three rungs the existing card renderers
   *  already understand; see `COARSE_FROM_LEVEL`. */
  level: InsightLevel;
  /** How big this finding is ON THIS BOOK, and the ladder that graded
   *  it. Never absent — a rule that declines to be graded says so here
   *  with a reason (`materiality: null`, `absoluteWhy` set). */
  materiality: ConditionMateriality;
  /** 1-based position in `detectConditions`' returned order. */
  rank: number;
  /** The ordering rule, printed verbatim so the list explains itself. */
  rankBasis: string;
  title: string;
  /** A cited fact the envelope did not carry is `null`, never 0 — the
   *  citation list is what a reader checks the card's claim against. */
  factsCited: Record<string, number | null>;
  /** Static rationale — used when Opus narrative isn't available. */
  rationaleFallback: string;
  /** Static action list — used when Opus narrative isn't available. */
  actionsFallback: string[];
  /** Static "what not to do" warning. */
  whatNotToDoFallback?: string;
}

// ══════════════════════════════════════════════════════════════════════
// R4 — SEVERITY IS SCALED TO THIS BOOK, AND SO IS THE ORDER
// ══════════════════════════════════════════════════════════════════════
//
// THE DEFECT THIS REPLACES, measured on the committed `agras` fixture
// (2026-09-07, `generateRecommendations` over the served envelope):
//
//   [high] covenant_monitoring_dashboard — "Stand up monthly DSCR /
//          Debt-EBITDA monitoring dashboard"
//   [info] refinance_opportunity — "Refinance window: DSCR 7.43× and
//          adjusted Debt/EBITDA 0.20× are bankable"
//
// Two recommendations, both about debt, on a book at 0.20× Debt/EBITDA
// and a 60.9% equity ratio whose pre-tax profit is ABOVE its operating
// EBIT — it earns more below the operating line than it pays on debt.
// The whole quantified prize was RON 18,201/year, 0.24% of a RON
// 7,533,676 net profit. Nothing was said about RON 7,692,203 of
// intercompany receivables (32.2% of equity) or a 70.4%-depreciated
// asset base, both of which the insight engine measures on the same
// book and both of which are worth orders of magnitude more.
//
// The cause was structural: `severity` was a CONSTANT written into each
// rule ("critical", "attention", "info"), and the only ordering was that
// constant. A rule's own size on the subject company was never computed,
// so a process recommendation worth nothing could outrank a finding
// worth a third of equity, and did.
//
// WHY THIS IS NOT A SECOND, COMPETING LADDER. The engine-side insight
// package already grades this way (`src/engine/insights/severity.py`,
// `rank.py`, `packs/insights/detectors.yaml`). Insights and
// recommendations print in ONE document, so they must agree about what
// matters. This module therefore reuses that lane's vocabulary rather
// than inventing one: `InsightLevel` and `SEVERITY_ORDER` are IMPORTED
// from `insights.ts`, `grade()` below is the same arithmetic as
// `severity.py::grade` (first band whose `at_least` is met, top-down),
// the ordering is the same (level, then materiality descending, then id
// ascending), and `RANKING_STATEMENT` mirrors the pack's own sentence.
// Where a rule measures the SAME quantity as a detector, it borrows the
// detector's basis, ladder and wording verbatim — see
// `intercompany_receivable_recall`, which grades against total equity
// on the ladder `related_party_exposure` uses, so the two surfaces
// cannot print different levels for one exposure (R1 across surfaces).

export interface ConditionMateriality {
  /** What was measured, in the book's currency (or already a share). */
  magnitude: number | null;
  magnitudeLabel: string;
  /** The company-scale figure it is divided by. */
  basisValue: number | null;
  basisLabel: string;
  /** |magnitude| ÷ basisValue. `null` when no usable basis existed —
   *  never 0, which would claim the finding is small. */
  materiality: number | null;
  /** The ladder actually read. Rendered beside the verdict so the
   *  cutoffs come from the same table the verdict used (TC-10). */
  bands: InsightSeverityBand[];
  /** Why this basis is the defensible scale for this rule. */
  basisWhy: string;
  /** Set on the rules that are DELIBERATELY not materiality-scaled,
   *  carrying the reason. See `ABSOLUTE_*` below. */
  absoluteWhy?: string;
}

/** The five-rung level collapsed onto the three rungs the existing card
 *  renderers already switch on. Monotonic, so a stable sort by the
 *  coarse value can never reorder two findings the fine grade
 *  separated. */
const COARSE_FROM_LEVEL: Record<InsightLevel, Severity> = {
  critical: "critical",
  high: "attention",
  medium: "attention",
  low: "info",
  info: "info",
};

/** The ordering rule, printed on every condition. Mirrors
 *  `packs/insights/detectors.yaml` → `ranking.statement`, because the
 *  two lists sit in one document and a reader may not have two
 *  different explanations of why one row is above another. */
export const RANKING_STATEMENT =
  "Ranked by severity level, then by materiality descending; ties broken " +
  "by rule key ascending. Severity is a share of a figure taken from this " +
  "company, never an absolute amount.";

/** `severity.py::grade`, in TypeScript.
 *
 *  ABSENT ≠ SMALL: an unmeasurable magnitude or an unusable basis grades
 *  `info` with `materiality: null` and a stated reason, never `low`
 *  (which would assert the finding is small) and never 0. */
function grade(
  magnitude: number | null,
  magnitudeLabel: string,
  basisValue: number | null,
  basisLabel: string,
  bands: InsightSeverityBand[],
  basisWhy: string,
): { level: InsightLevel; materiality: ConditionMateriality } {
  const shell = (level: InsightLevel, materiality: number | null) => ({
    level,
    materiality: {
      magnitude,
      magnitudeLabel,
      basisValue,
      basisLabel,
      materiality,
      bands,
      basisWhy,
    },
  });
  if (!has(magnitude)) return shell("info", null);
  if (!has(basisValue) || basisValue <= 0) return shell("info", null);
  const share = Math.abs(magnitude) / basisValue;
  let level: InsightLevel = "info";
  for (const band of bands) {
    if (band.at_least === null || share >= band.at_least) {
      level = band.level;
      break;
    }
  }
  return shell(level, share);
}

/** The three `true_*` rules are deliberately EXEMPT from materiality
 *  scaling, and the exemption is stated rather than assumed. Each is a
 *  solvency threshold — cover below 1.0, equity below zero, EBITDA below
 *  zero — that a book either crosses or does not; dividing the crossing
 *  by the company's size would make a small company's insolvency a small
 *  finding, which is the one place the ladder would do harm. */
export const ABSOLUTE_WHY =
  "Filed critical without a materiality share: this is a solvency " +
  "threshold, not a size. A book crosses it or it does not, and a small " +
  "company's crossing is not a small finding.";

/** A finding that is NOT graded on a share, with the reason recorded. */
function absolute(
  level: InsightLevel,
  magnitude: number | null,
  magnitudeLabel: string,
  why: string,
): { level: InsightLevel; materiality: ConditionMateriality } {
  return {
    level,
    materiality: {
      magnitude,
      magnitudeLabel,
      basisValue: null,
      basisLabel: "not scaled",
      materiality: null,
      bands: [],
      basisWhy: why,
      absoluteWhy: why,
    },
  };
}

/** Ladders. Each is data, read by `grade` and PRINTED back by
 *  `ladderSentence` into the card's own prose, so the cutoffs a reader
 *  sees are the cutoffs the verdict used (TC-10) rather than a second
 *  copy in a sentence that can drift. */
const BANDS = {
  /** Cash saved or cash cost, per year, against a year of earnings. */
  annualMoney: [
    { level: "critical" as InsightLevel, at_least: 0.05 },
    { level: "high" as InsightLevel, at_least: 0.02 },
    { level: "medium" as InsightLevel, at_least: 0.01 },
    { level: "low" as InsightLevel, at_least: 0.005 },
    { level: "info" as InsightLevel, at_least: null },
  ],
  /** A balance held against the equity that would absorb its loss. This
   *  IS `related_party_exposure`'s ladder in
   *  `packs/insights/detectors.yaml`, copied rung for rung so one
   *  exposure cannot be graded twice in one document. */
  exposureOfEquity: [
    { level: "critical" as InsightLevel, at_least: 0.5 },
    { level: "high" as InsightLevel, at_least: 0.25 },
    { level: "medium" as InsightLevel, at_least: 0.1 },
    { level: "low" as InsightLevel, at_least: 0.02 },
    { level: "info" as InsightLevel, at_least: null },
  ],
  /** A balance held against the balance sheet it sits in. */
  shareOfAssets: [
    { level: "critical" as InsightLevel, at_least: 0.4 },
    { level: "high" as InsightLevel, at_least: 0.25 },
    { level: "medium" as InsightLevel, at_least: 0.12 },
    { level: "low" as InsightLevel, at_least: 0.05 },
    { level: "info" as InsightLevel, at_least: null },
  ],
  /** How much of a stated covenant tier the book has already consumed.
   *  1.0 means it is AT or PAST the tier. */
  tierConsumed: [
    { level: "critical" as InsightLevel, at_least: 1.0 },
    { level: "high" as InsightLevel, at_least: 0.85 },
    { level: "medium" as InsightLevel, at_least: 0.65 },
    { level: "low" as InsightLevel, at_least: 0.4 },
    { level: "info" as InsightLevel, at_least: null },
  ],
  /** A share of the top line. */
  shareOfRevenue: [
    { level: "critical" as InsightLevel, at_least: 0.5 },
    { level: "high" as InsightLevel, at_least: 0.3 },
    { level: "medium" as InsightLevel, at_least: 0.15 },
    { level: "low" as InsightLevel, at_least: 0.05 },
    { level: "info" as InsightLevel, at_least: null },
  ],
  /** An obligation against the cash on hand to settle it. */
  shareOfCash: [
    { level: "critical" as InsightLevel, at_least: 1.0 },
    { level: "high" as InsightLevel, at_least: 0.5 },
    { level: "medium" as InsightLevel, at_least: 0.25 },
    { level: "low" as InsightLevel, at_least: 0.05 },
    { level: "info" as InsightLevel, at_least: null },
  ],
};

/** The covenant tiers the monitoring card proposes. They used to exist
 *  ONLY as a sentence inside that card's action list, which is why
 *  nothing could compare a book against them and the card asserted
 *  "meaningful headroom" on a book at 0.09× DSCR. They are data now: the
 *  verdict reads them and the action list renders from them, so the
 *  cutoffs a reader is shown are the cutoffs they were measured on
 *  (TC-10). */
export const MONITORING_TIERS = {
  green: { dscr: 1.5, dte: 5.5 },
  amber: { dscr: 1.3, dte: 6.5 },
  /** The DSCR floor a Romanian lender typically tests. The GREEN and
   *  AMBER rungs above exist to keep a book clear of THIS number, and
   *  three other rules in this file already benchmark against it, so the
   *  card that proposes the tiers names the floor they protect rather
   *  than presenting 1.50 / 1.30 as free-standing choices. */
  covenantFloor: 1.25,
};

/** The level collapse, exported so a gate can check the MAPPING for
 *  monotonicity instead of checking whatever levels four fixture books
 *  happen to emit. A plant that broke the mapping red nothing while the
 *  gate walked the books. */
export const COARSE_FOR_TEST = COARSE_FROM_LEVEL;

/** The ladders, for gates that must assert against the SAME table the
 *  verdict read rather than restating a cutoff in a test file — a test
 *  that carries its own copy of a threshold is the drift it exists to
 *  catch. */
export const BANDS_FOR_TEST = BANDS;

/** The lowest rung that is not the `info` floor. A rule whose own
 *  measured size does not reach it has nothing worth a card — this is
 *  the FIRE FLOOR, and it is the same number the card would print as
 *  its `low` cutoff, so suppression and grading read one table. */
function fireFloor(bands: InsightSeverityBand[]): number {
  for (let i = bands.length - 1; i >= 0; i -= 1) {
    if (bands[i].at_least !== null) return bands[i].at_least as number;
  }
  return 0;
}

/** Does this measurement clear the ladder's lowest graded rung?
 *
 *  It asks `grade` for the share rather than dividing again. A plant
 *  that made `grade`'s arithmetic absolute left this function computing
 *  the honest share, so a rule could be SUPPRESSED on one number and
 *  GRADED on a different one — two values for one concept inside a
 *  single rule. One arithmetic, one place. */
function clearsFloor(
  magnitude: number | null,
  basisValue: number | null,
  bands: InsightSeverityBand[],
): boolean {
  const share = grade(magnitude, "", basisValue, "", bands, "").materiality
    .materiality;
  return share !== null && share >= fireFloor(bands);
}

/** The ladder as a sentence, rendered FROM the band array. */
export function ladderSentence(m: ConditionMateriality): string {
  if (m.absoluteWhy) return m.absoluteWhy;
  const rungs = m.bands
    .filter((b) => b.at_least !== null)
    .map(
      (b) =>
        `${SEVERITY_LABEL[b.level].toLowerCase()} ≥ ${((b.at_least as number) * 100).toFixed(
          (b.at_least as number) < 0.01 ? 2 : 1,
        )}%`,
    )
    .join(" · ");
  const measured =
    m.materiality === null
      ? `${m.basisLabel} is not available on this book, so no share can be stated`
      : `measured at ${sharePct(m.materiality)}`;
  return `Graded on ${m.magnitudeLabel} as a share of ${m.basisLabel.toLowerCase()} — ${measured}; the ladder is ${rungs}. ${m.basisWhy}`;
}

/** A share as a percentage that never prints a real number as "0.0%":
 *  the precision widens until a significant digit survives. Mirrors
 *  `formatMeasure`'s rule in `insights.ts` so the two surfaces do not
 *  spell the same share differently. */
function sharePct(v: number): string {
  const pct = v * 100;
  if (pct === 0) return "0%";
  for (const digits of [1, 2, 3, 4]) {
    const text = pct.toFixed(digits);
    if (Number(text) !== 0) return `${text}%`;
  }
  return "<0.0001%";
}

/** The result BELOW the operating line: pre-tax profit − operating EBIT.
 *
 *  Deliberately NOT called "net financial result". `PeriodFacts.pl`
 *  carries a field of that name, but the report entry point
 *  (`financialReport.ts`'s `safeFacts`) hard-codes it to 0 for every
 *  book, so a rule reading it cannot tell "this company earns and pays
 *  nothing below the operating line" from "nobody plumbed the field".
 *  Two operands that ARE plumbed on both entry points bracket the same
 *  span, and their difference is measurable today: on the committed
 *  `agras` fixture it is +112,507.14, which is exactly the envelope's
 *  `assembled_pl.net_financial_result`.
 *
 *  It is not identical on every book — on `retail` the difference is
 *  2,416,709.01 against a served `net_financial_result` of 2,418,632.79,
 *  a 1,923.78 residual that sits between EBIT and pre-tax and is not
 *  financial. Hence the separate NAME: this is the whole span below the
 *  operating line, and the rules only ever read its SIGN. */
function belowOperatingLine(f: PeriodFacts): number | null {
  const pretax = f.pl.profit_before_tax;
  const ebit = f.pl.ebit;
  if (!has(pretax) || !has(ebit)) return null;
  return pretax - ebit;
}

/** |net profit| — the annual scale an annual saving or cost is worth
 *  measuring against. Absolute because a loss is still a scale: a book
 *  losing 30M is a big book, and a 16k contingency is small on it. The
 *  label says so, the way the insight pack's `_FALLBACK_LABELS` prints
 *  "EBITDA (absolute)". Falls back to revenue when the result is nil. */
function annualScale(f: PeriodFacts): { value: number | null; label: string } {
  const ni = f.pl.net_profit;
  if (has(ni) && ni > 0) return { value: ni, label: "Net profit" };
  if (has(ni) && ni < 0) {
    return { value: Math.abs(ni), label: "Net result (absolute)" };
  }
  const rev = f.pl.revenue;
  if (has(rev) && rev > 0) return { value: rev, label: "Revenue" };
  return { value: null, label: "Net profit" };
}

// ─── Rule registry ──────────────────────────────────────────────────────

/** What a rule's `detect` returns — the condition without the fields
 *  the registry computes for it (`level`, `severity`, `rank`,
 *  `rankBasis`). A rule states its own materiality; it never states its
 *  own level. */
type RuleFinding = Omit<
  DetectedCondition,
  "level" | "severity" | "rank" | "rankBasis" | "materiality"
> & { graded: { level: InsightLevel; materiality: ConditionMateriality } };

interface Rule {
  key: string;
  /** When set, the rule only fires for these industries. Omit = all. */
  industries?: string[];
  detect: (facts: PeriodFacts) => RuleFinding | null;
}

const RON = (n: number) => `RON ${Math.round(n).toLocaleString()}`;

// ─── Absent-ratio discipline ────────────────────────────────────────────
//
// `RatioFacts` values are `number | null`. Two things must never happen
// in a rule:
//
//   1. A THRESHOLD read off an absent ratio. JavaScript coerces `null`
//      to 0 in relational comparisons, so `null <= 1.35` is true and
//      `null < 0` is FALSE — the second shape is how a
//      negative-equity rule (Law 31/1990 art. 153^24) silently stops
//      firing. `has()` makes the presence test explicit so no rule
//      depends on coercion for its behaviour.
//   2. A CITATION of an absent ratio in prose. A rule can be correctly
//      silent about a ratio and still quote it inside ANOTHER rule's
//      sentence; that is exactly how "equity ratio 0.0% vs typical 30%
//      floor" reached a CRITICAL card for a company at 14.7%.
//
/** True only for a real, finite measurement. */
const has = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** The word prose uses where an absent ratio would have gone. Stating
 *  the absence keeps the sentence honest; printing "0.00" does not. */
const UNMEASURED = "not reported";

/** `x.toFixed(d)` for a possibly-absent ratio. */
const fx = (v: number | null | undefined, digits: number): string =>
  has(v) ? v.toFixed(digits) : UNMEASURED;

/** A possibly-absent ratio rendered as a percentage. */
const pctOf = (v: number | null | undefined, digits: number): string =>
  has(v) ? `${(v * 100).toFixed(digits)}%` : UNMEASURED;

const RULES: Rule[] = [
  // ══════════════════════════════════════════════════════════════════
  // ACTIONABLE OPPORTUNITIES — fire when conditions are favorable
  // ══════════════════════════════════════════════════════════════════

  // R1. Refinance opportunity (graded)
  //
  // ── THE TRIGGER WAS THE DEFECT, NOT ONLY THE RANK ──────────────────
  //
  // Measured on the committed `agras` fixture before this repair: the
  // card fired, and the entire prize it quantified was RON 18,201/year
  // on a book earning RON 7,533,676. 0.24%. Two things were wrong with
  // the trigger, and both are now conditions:
  //
  //   1. NOTHING TESTED WHETHER THE DEBT WAS WORTH REPRICING. The guards
  //      were `dscr > 1.35`, `0 < adjusted Debt/EBITDA < 6.0` and a flat
  //      `bank_debt_total >= 1,000,000` — three statements that the debt
  //      is SAFE, plus one absolute floor that says nothing about the
  //      subject company. A book with 0.20× leverage passes all four,
  //      which is why this fired on the least-levered book in the
  //      corpus. The prize is now graded against a year of the
  //      company's own earnings and must clear the ladder's lowest
  //      graded rung.
  //   2. A BOOK THAT EARNS MORE BELOW THE OPERATING LINE THAN IT PAYS
  //      HAS NO REFINANCING PROBLEM. `agras` reports pre-tax profit
  //      ABOVE its operating EBIT (+112,507.14); the insight engine
  //      states the same fact from the other side — financial income
  //      456,384.14 against financial expense 343,877.00. Advising it to
  //      shop the debt is advice about the wrong side of the account.
  //
  // The absolute `bank_debt_total >= 1,000,000` floor is GONE. It was
  // the only "materiality" the rule had and it was a fixed number in RON
  // — the same figure for a 39M book and a 400M one.
  {
    key: "refinance_opportunity",
    detect: (f) => {
      const dscr = f.ratios.dscr;
      const dteAdj = f.ratios.debt_to_ebitda_adjusted;
      // A "bankable" verdict needs BOTH ratios actually measured. Left
      // to coercion, `null <= 1.35` happened to be true and the rule
      // stayed silent by accident; the presence test says so on purpose.
      if (!has(dscr) || !has(dteAdj)) return null;
      if (dscr <= 1.35 || dteAdj <= 0 || dteAdj >= 6.0) return null;
      if (f.bs.bank_debt_total <= 0 || f.pl.interest_expense <= 0) return null;
      // GUARD 2 — the sign of the result below the operating line. A
      // positive span means the book takes MORE below the operating
      // line than it gives up; there is no interest bill to shop.
      // `null` (neither operand plumbed) does not suppress: an absence
      // is not evidence, and the safe direction for a missing fact is to
      // let the materiality floor below decide.
      const belowLine = belowOperatingLine(f);
      if (has(belowLine) && belowLine > 0) return null;
      const currentRate = f.pl.interest_expense / Math.max(f.bs.bank_debt_total, 1);
      const savings50bps = f.bs.bank_debt_total * 0.005;
      const scale = annualScale(f);
      // GUARD 1 — the prize must reach the ladder's lowest graded rung.
      if (!clearsFloor(savings50bps, scale.value, BANDS.annualMoney)) return null;
      const graded = grade(
        savings50bps,
        "Interest saved per 50bps",
        scale.value,
        scale.label,
        BANDS.annualMoney,
        "A refinancing is worth a management conversation when the money " +
          "it saves is material against what the company earns in a year, " +
          "not when the debt clears an absolute size in RON.",
      );
      return {
        ruleKey: "refinance_opportunity",
        graded,
        title: `Refinance window: DSCR ${fx(dscr, 2)}× and adjusted Debt/EBITDA ${fx(dteAdj, 2)}× are bankable`,
        factsCited: {
          dscr,
          debt_to_ebitda_adjusted: dteAdj,
          bank_debt_total: f.bs.bank_debt_total,
          interest_expense: f.pl.interest_expense,
          current_rate: currentRate,
          potential_savings_per_50bps: savings50bps,
          result_below_operating_line: belowLine,
        },
        rationaleFallback:
          `DSCR ${fx(dscr, 2)}× and adjusted Debt/EBITDA ${fx(dteAdj, 2)}× ` +
          // A zero here used to print as "(including RON 0 dividend
          // income from participations)" — a parenthetical citing an
          // absence as though it were a measured contribution.
          (has(f.pl.dividend_income) && f.pl.dividend_income > 0
            ? `(including ${RON(f.pl.dividend_income)} dividend income from participations) `
            : "") +
          `put the company in bankable territory. Current rate ~${(currentRate * 100).toFixed(2)}% ` +
          `(${RON(f.pl.interest_expense)} interest on ${RON(f.bs.bank_debt_total)} debt) ` +
          `is worth testing against competing offers — every 50bps saved is ${RON(savings50bps)}/year. ` +
          ladderSentence(graded.materiality),
        actionsFallback: [
          "Request indicative term sheets from 2–3 alternative lenders (BCR, ING Romania, Banca Transilvania) for refinancing 30-50% of the current balance.",
          "Frame as syndication, not full replacement, to keep the existing lender relationship intact.",
          "Time the refinance to before the next major capex drawdown so the new lender prices the post-capex cash flow profile.",
          // SECTOR-NEUTRAL. This rule declares no `industries`, so it fires
          // on every book — and it was advising a meat processor to
          // negotiate an "LTV ceiling" and refuse "MAC clauses tied to
          // single-tenant risk". Loan-to-value and single-tenant risk are
          // property-lending terms; a manufacturer's lender prices leverage
          // and cover. Gating the rule by sector was the wrong fix, because
          // the rule genuinely applies everywhere: the PROSE had to stop
          // assuming one.
          //
          // The 1.25× DSCR floor STAYS. Debt service cover is what every
          // lender in every sector tests, and the first edit stripped it
          // along with the property terms — over-correcting a sector leak
          // into a vaguer, less useful recommendation. The
          // covenant-targets gate caught that: it asserts every declared
          // target is actually printed somewhere, so removing one left an
          // unused allow-list entry and went red.
          "Negotiate the covenant package: target a DSCR floor of 1.25× and a leverage ceiling you can hold through a bad quarter, and resist step-ups that tighten faster than the business can deleverage.",
        ],
        whatNotToDoFallback:
          "Don't ask the incumbent lender for a rate cut without alternatives in hand — without competing offers, there's no leverage.",
      };
    },
  },

  // R2. Lender concentration (medium)
  // Fires when 95%+ of bank debt sits with one lender — structural risk
  // that caps the credit rating regardless of operating performance.
  {
    key: "lender_concentration",
    detect: (f) => {
      const conc = f.bs.lender_concentration_pct;
      if (conc === undefined || conc < 0.95 || f.bs.bank_debt_total < 3_000_000) {
        return null;
      }
      const splitMin = f.bs.bank_debt_total * 0.3;
      const splitMax = f.bs.bank_debt_total * 0.5;
      const graded = grade(
        f.bs.bank_debt_total * conc,
        "Debt with the single lender",
        f.bs.total_assets,
        "Total assets",
        BANDS.shareOfAssets,
        "One lender's exposure is graded against the balance sheet it " +
          "finances: the same RON with one bank is a structural " +
          "dependency on a small book and a rounding error on a large one.",
      );
      return {
        ruleKey: "lender_concentration",
        graded,
        title: `Single-lender concentration: ${(conc * 100).toFixed(0)}% of ${RON(f.bs.bank_debt_total)} debt with one bank`,
        factsCited: {
          bank_debt_total: f.bs.bank_debt_total,
          lender_concentration_pct: conc,
          suggested_split_min: splitMin,
          suggested_split_max: splitMax,
        },
        rationaleFallback:
          `${(conc * 100).toFixed(0)}% of the company's ${RON(f.bs.bank_debt_total)} bank debt sits with a single lender. ` +
          `A single-lender concentration creates rating sensitivity (any covenant issue becomes existential) ` +
          `and limits negotiating leverage on rate / amortization terms. Splitting 30-50% to a second lender ` +
          `removes the single-counterparty rating cap without changing P&L.`,
        actionsFallback: [
          `Identify ${RON(splitMin)}–${RON(splitMax)} of total debt to refinance with a second lender.`,
          "Maintain the existing lender relationship for the rest — the goal is diversification, not replacement.",
          "Use the syndication conversation (see Refinance window card) as the mechanism.",
          "Time the split with the next covenant reset window so the new facility prices fresh.",
        ],
      };
    },
  },

  // R3. Tenant concentration (medium/high) — CRE only
  // Fires when one tenant >70% of rental revenue. Lease renewal becomes
  // the single most important capital-structure decision.
  {
    key: "tenant_concentration_renewal",
    industries: ["real_estate_commercial", "real_estate_residential"],
    detect: (f) => {
      const conc = f.bs.tenant_concentration_pct;
      if (conc === undefined || conc < 0.7) return null;
      const revAtRisk = f.pl.rental_revenue * conc;
      const graded = grade(
        revAtRisk,
        "Revenue turning on one lease",
        f.pl.revenue,
        "Revenue",
        BANDS.shareOfRevenue,
        "A concentration is graded against the top line it can remove, " +
          "so the verdict moves with how much of THIS company's income " +
          "the lease actually carries.",
      );
      return {
        ruleKey: "tenant_concentration_renewal",
        graded,
        title: `Tenant concentration: top tenant = ${(conc * 100).toFixed(0)}% of ${RON(f.pl.rental_revenue)} rental revenue`,
        factsCited: {
          top_tenant_pct: conc,
          rental_revenue: f.pl.rental_revenue,
          revenue_at_risk: revAtRisk,
        },
        rationaleFallback:
          `The top tenant represents ${(conc * 100).toFixed(0)}% of rental revenue ` +
          `(${RON(revAtRisk)} of ${RON(f.pl.rental_revenue)}). Losing this tenant without a 12-month replacement ` +
          `would compress EBITDA materially and likely breach the 1.25× DSCR covenant. ` +
          `Securing the next lease term is the most important capital-structure decision this year. ` +
          ladderSentence(graded.materiality),
        actionsFallback: [
          "Open the renewal conversation 12-18 months before current term expiry.",
          "Push for a 5-7 year term with CPI indexation (caps FX risk on EUR-denominated rent).",
          "Include early-termination penalty clauses sized to the cost of replacement marketing + downtime.",
          "Identify 2-3 backup tenants for the same property type so the renewal negotiation has a real BATNA.",
        ],
        whatNotToDoFallback:
          "Don't wait for the tenant to initiate the renewal — the side that opens the conversation sets the anchor on rent and term.",
      };
    },
  },

  // R4. Intercompany receivable recall (medium/high)
  // Material RON sitting in related-party receivables while interest is
  // paid on senior debt. Recall + prepay = pure capital-structure win.
  {
    key: "intercompany_receivable_recall",
    detect: (f) => {
      const ic = f.bs.intercompany_loans;
      // `Math.max(null, 1)` is 1. With an ABSENT total-assets figure the
      // share of assets came out as `ic / 1` — a percentage in the
      // millions — and the rule fired as "critical" citing a
      // `total_assets` it never had. A share of an unknown base is not a
      // share; the rule has nothing to say.
      const totalAssets = f.bs.total_assets;
      if (totalAssets === null || totalAssets <= 0) return null;
      const pct = ic / totalAssets;
      // ── THE SAME EXPOSURE, GRADED ONCE (R1 ACROSS SURFACES) ────────
      // The insight engine's `related_party_exposure` detector measures
      // this exact balance and grades it against TOTAL EQUITY, on the
      // ladder 0.50 / 0.25 / 0.10 / 0.02, with the reason "equity is the
      // cushion a lender writes the exposure off against". Both print in
      // one document, so this rule uses that basis, that ladder and that
      // reason instead of its own `pct > 0.15` on assets — otherwise the
      // report could call one balance `high` in one section and
      // `critical` in another. On `agras` the exposure is 32.15% of
      // equity, which is `high` on both surfaces.
      // The absolute `ic <= 500_000` floor is gone with it: half a
      // million RON is a different thing on a 39M book than on a 400M one.
      if (!clearsFloor(ic, f.bs.total_equity, BANDS.exposureOfEquity)) return null;
      const currentRate = f.pl.interest_expense / Math.max(f.bs.bank_debt_total, 1);
      const interestSavings = ic * currentRate;
      const newDte =
        f.pl.ebitda > 0 ? (f.bs.bank_debt_total - ic) / f.pl.ebitda : 0;
      const graded = grade(
        ic,
        "Related-party receivables",
        f.bs.total_equity,
        "Total equity",
        BANDS.exposureOfEquity,
        "Equity is the cushion a lender writes the exposure off against, " +
          "so the exposure is graded as a share of that cushion rather " +
          "than of the balance sheet it is already inside.",
      );
      return {
        ruleKey: "intercompany_receivable_recall",
        graded,
        title: `Recall ${RON(ic)} intercompany receivable to prepay senior debt`,
        factsCited: {
          intercompany_loans: ic,
          total_assets: totalAssets,
          pct_of_assets: pct,
          total_equity: f.bs.total_equity,
          bank_debt_total: f.bs.bank_debt_total,
          current_rate: currentRate,
          interest_savings_if_repaid: interestSavings,
          new_debt_to_ebitda: newDte,
        },
        rationaleFallback:
          `Account 461 (Sundry debtors) holds ${RON(ic)} in intercompany receivables — ` +
          `${(pct * 100).toFixed(1)}% of total assets sitting unproductively while the company pays ` +
          `~${(currentRate * 100).toFixed(2)}% interest on senior bank debt. Recalling the receivable ` +
          `and using it to prepay would reduce annual interest by ${RON(interestSavings)} and drop ` +
          `Debt/EBITDA from ${fx(f.ratios.debt_to_ebitda, 2)}${has(f.ratios.debt_to_ebitda) ? "×" : ""} to ${newDte.toFixed(2)}× (more bankable territory). ` +
          ladderSentence(graded.materiality),
        actionsFallback: [
          `Confirm with the related party that the ${RON(ic)} receivable is recoverable in cash within 90 days.`,
          "Structure the recall as a formal repayment (debt-vs-debt offset, not a fresh loan) to avoid tax / AGM complications.",
          "Apply proceeds to senior principal; request the lender update the amortization schedule.",
          "Document the transaction for the audit trail — related-party movements draw scrutiny from RO tax authorities.",
        ],
        whatNotToDoFallback:
          "Don't paper over the receivable with another loan refresh — that just rolls the problem forward.",
      };
    },
  },

  // R5a. Covenant documentation audit (critical)
  // Fires for any company with > RON 3M of bank debt and 100% lender
  // concentration — the loan agreements' actual covenant package needs
  // to be known before any other capital-structure recommendation can be
  // sized. Zero cash cost; pure information gain.
  {
    key: "covenant_documentation_audit",
    detect: (f) => {
      const conc = f.bs.lender_concentration_pct;
      if (conc === undefined || conc < 0.95) return null;
      // The `bank_debt_total < 3_000_000` floor is replaced by the
      // ladder's own lowest rung: what matters is how much of THIS
      // balance sheet is financed on terms nobody has read, not whether
      // the number clears three million RON.
      if (!clearsFloor(f.bs.bank_debt_total, f.bs.total_assets, BANDS.shareOfAssets)) {
        return null;
      }
      const graded = grade(
        f.bs.bank_debt_total,
        "Debt on undocumented terms",
        f.bs.total_assets,
        "Total assets",
        BANDS.shareOfAssets,
        "The finding is how much of the balance sheet is financed on a " +
          "covenant package nobody has read, so it is graded against that " +
          "balance sheet. It used to be filed CRITICAL on every book, " +
          "which put a documentation errand above every measured finding.",
      );
      return {
        ruleKey: "covenant_documentation_audit",
        graded,
        title: `Pull the loan agreements — full covenant audit before any other capital-structure move`,
        factsCited: {
          bank_debt_total: f.bs.bank_debt_total,
          lender_concentration_pct: conc,
          interest_expense: f.pl.interest_expense,
        },
        rationaleFallback:
          `${(conc * 100).toFixed(0)}% of debt sits with one lender on terms not yet documented in this analysis. ` +
          // ⚠ F4 LIVED HERE. `(null * 100).toFixed(1)` is "0.0", so
          // deleting `totals.equity` from the envelope printed
          // "equity ratio 0.0% vs typical 30% floor" — a company far
          // below its covenant floor — inside a CRITICAL card, off a
          // book whose equity ratio was never read. Same for DSCR.
          `Without the actual loan agreements, the covenant headroom estimates (DSCR ${fx(f.ratios.dscr, 2)}${has(f.ratios.dscr) ? "×" : ""} vs typical 1.25×, ` +
          `equity ratio ${pctOf(f.ratios.equity_ratio, 1)} vs typical 30% floor) are estimates — ` +
          `the exact triggers depend on the contract package. ` +
          ladderSentence(graded.materiality),
        actionsFallback: [
          "Within 1 week, obtain complete loan documentation: interest rate structure (fixed vs EURIBOR + margin), prepayment penalties and cure provisions, full covenant package (DSCR / LTV / Debt-EBITDA / equity-ratio thresholds + measurement frequency), cross-default provisions between contracts, MAC clauses.",
          "Catalogue covenant test dates so the monitoring dashboard (see related card) aligns with the compliance cycle.",
          "Identify cure mechanics — equity injection, partial prepayment, asset sale — for each covenant so a remediation plan exists before any trigger.",
        ],
        whatNotToDoFallback:
          "Don't approach the lender for any modification (rate, term, syndication) before having the current terms in hand — without the baseline, there's no leverage.",
      };
    },
  },

  // R5b. Property tax reassessment provision (medium) — CRE only
  // Bucharest authorities periodically revalue commercial property. A
  // 50% reassessment spike on a multi-million property book can take
  // DSCR from comfortable to tight without warning.
  {
    key: "property_tax_reassessment_provision",
    industries: ["real_estate_commercial", "real_estate_residential"],
    detect: (f) => {
      const propBook = f.bs.investment_property_net;
      if (propBook < 5_000_000) return null;
      // Estimate downside: 50% reassessment on 1% effective rate = 0.5% of book
      const downsideImpact = propBook * 0.005 * 0.5;
      const provisionTarget = Math.max(downsideImpact * 1.2, 50_000);
      const scale = annualScale(f);
      const graded = grade(
        downsideImpact,
        "Estimated annual tax increase",
        scale.value,
        scale.label,
        BANDS.annualMoney,
        "An annual cost is graded against a year of this company's own " +
          "result, so a contingency that would be existential on a small " +
          "book and immaterial on a large one does not carry one verdict.",
      );
      return {
        ruleKey: "property_tax_reassessment_provision",
        graded,
        title: `Build a ${RON(provisionTarget)} provision for property tax reassessment`,
        factsCited: {
          investment_property_net: propBook,
          downside_impact_estimate: downsideImpact,
          provision_target: provisionTarget,
          dscr_current: f.ratios.dscr,
        },
        rationaleFallback:
          `Investment property carries ${RON(propBook)} at book; Romanian municipalities periodically revalue commercial property. ` +
          `A 50% reassessment spike on a property of this size would add roughly ${RON(downsideImpact)} of annual property tax` +
          // "tighten DSCR ... TOWARD the covenant floor" was printed
          // unconditionally. On the committed `realestate` book DSCR is
          // -5.86×, already far BELOW any floor, so the sentence told a
          // reader in breach that a contingency might one day take them
          // near it. The direction is now read off the ratio.
          (has(f.ratios.dscr) && f.ratios.dscr > 1.25
            ? ` — survivable, but it would tighten DSCR from ${fx(f.ratios.dscr, 2)}× toward the covenant floor unnecessarily.`
            : has(f.ratios.dscr)
              ? `. DSCR is already ${fx(f.ratios.dscr, 2)}×, below the 1.25× floor a lender would test, so this would deepen an existing shortfall rather than threaten a comfortable one.`
              : `. DSCR is not reported on this book, so the effect on covenant headroom cannot be stated.`) +
          ` ` + ladderSentence(graded.materiality),
        actionsFallback: [
          "Pre-engage a property tax advisor to model the reassessment scenario and prepare a defense package (comparable transactions, building condition, lease terms).",
          `Build a ${RON(provisionTarget)} balance-sheet provision against the contingency.`,
          "Time the provision build with the lender review cycle so the protection is visible at the next covenant test.",
        ],
      };
    },
  },

  // R5c. Covenant monitoring dashboard (graded)
  //
  // ── THIS IS THE CARD THAT LED THE OWNER'S AGRAS REPORT ─────────────
  //
  // It fired on a flat `bank_debt_total >= 3,000,000` and was filed
  // "attention", which mapped to HIGH priority and put it at the top of
  // a two-card list on a book at 0.20× Debt/EBITDA and 7.43× DSCR.
  //
  // Its own prose then asserted, unconditionally and in every case, that
  // the ratios it had just printed "have meaningful headroom". Measured
  // on the committed fixtures, that sentence was FALSE on two of the
  // four books and the document contradicted itself on the page:
  //
  //   retail      "Current DSCR 0.09× and Debt/EBITDA 126.54× have
  //                meaningful headroom" — beside a CRITICAL card in the
  //                same list reading "DSCR 0.09× below 1.0".
  //   realestate  "Current DSCR -5.86× and Debt/EBITDA -0.64× have
  //                meaningful headroom".
  //
  // Both defects have one cause: the card carried cutoffs (the GREEN /
  // AMBER / RED tiers) only as PROSE in its action list, so nothing
  // could compare the book against them. The tiers are now DATA
  // (`MONITORING_TIERS`), the verdict is how much of the GREEN tier the
  // book has already consumed, and both the headroom sentence and the
  // action list render from that one table (TC-10).
  {
    key: "covenant_monitoring_dashboard",
    detect: (f) => {
      if (f.bs.bank_debt_total <= 0) return null;
      const dscr = f.ratios.dscr;
      const dte = f.ratios.debt_to_ebitda;
      // How much of the GREEN tier each dimension has eaten. 1.0 means
      // the book is AT or PAST it.
      const consumed: { label: string; value: number }[] = [];
      if (has(dscr)) {
        // Cover at or below zero has consumed the tier entirely; a
        // ratio of tier ÷ 0 is not a number a verdict may rest on.
        consumed.push({
          label: `DSCR ${fx(dscr, 2)}× against the ${MONITORING_TIERS.green.dscr.toFixed(2)}× green floor`,
          value: dscr > 0 ? MONITORING_TIERS.green.dscr / dscr : 1,
        });
      }
      if (has(dte) && f.pl.ebitda > 0) {
        consumed.push({
          label: `Debt/EBITDA ${fx(dte, 2)}× against the ${MONITORING_TIERS.green.dte.toFixed(1)}× green ceiling`,
          value: dte > 0 ? dte / MONITORING_TIERS.green.dte : 0,
        });
      }
      if (consumed.length === 0) return null;
      const binding = consumed.reduce((a, b) => (b.value > a.value ? b : a));
      const graded = grade(
        binding.value,
        "the green tier this book has consumed",
        1,
        "the green tier itself",
        BANDS.tierConsumed,
        "Monitoring is graded on how close THIS book already sits to the " +
          "tiers the dashboard would watch — the same tiers the action " +
          "list proposes — so a book with room reads as routine hygiene " +
          "and a book against the tier reads as urgent.",
      );
      const roomy = binding.value < BANDS.tierConsumed[3].at_least!;
      return {
        ruleKey: "covenant_monitoring_dashboard",
        graded,
        title: `Stand up monthly DSCR / Debt-EBITDA monitoring dashboard`,
        factsCited: {
          dscr_current: dscr,
          debt_to_ebitda_current: dte,
          bank_debt_total: f.bs.bank_debt_total,
          green_tier_dscr: MONITORING_TIERS.green.dscr,
          green_tier_debt_to_ebitda: MONITORING_TIERS.green.dte,
          green_tier_consumed: binding.value,
        },
        rationaleFallback:
          // "vacancy" here was a real-estate example on a rule that fires
          // for every sector. The shock named must be one the reader's own
          // business can suffer, so it names none and says "a bad quarter".
          `Annual covenant testing leaves blind spots between reviews — one bad quarter ` +
          `can push DSCR below the ${MONITORING_TIERS.covenantFloor.toFixed(2)}× floor a lender ` +
          `typically tests, without anyone noticing until the formal test. ` +
          // The headroom claim is now MEASURED against the tier, in both
          // directions, and names the binding dimension.
          (roomy
            ? `${binding.label} leaves real headroom — ${sharePct(binding.value)} of the green tier is used, so the time to install monitoring is now, not after the first warning.`
            : binding.value >= 1
              ? `${binding.label} is already AT or past that tier (${sharePct(binding.value)} of it used), so this is not preventative — the dashboard is how the next lender conversation gets prepared.`
              : `${binding.label} has used ${sharePct(binding.value)} of the green tier, so the margin is real but no longer comfortable.`) +
          ` ` + ladderSentence(graded.materiality),
        actionsFallback: [
          // Rendered from MONITORING_TIERS — the same table the verdict
          // above was read against, so the tiers a reader is asked to
          // adopt are the tiers they were just measured on.
          `Implement three-tier monthly tracking: GREEN (DSCR > ${MONITORING_TIERS.green.dscr.toFixed(2)}× / D-EBITDA < ${MONITORING_TIERS.green.dte.toFixed(1)}×), ` +
            `AMBER (${MONITORING_TIERS.amber.dscr.toFixed(2)}-${MONITORING_TIERS.green.dscr.toFixed(2)}× / ${MONITORING_TIERS.green.dte.toFixed(1)}-${MONITORING_TIERS.amber.dte.toFixed(1)}×), ` +
            `RED (< ${MONITORING_TIERS.amber.dscr.toFixed(2)}× / > ${MONITORING_TIERS.amber.dte.toFixed(1)}×).`,
          "AMBER triggers management review; RED triggers proactive lender engagement before the formal covenant test.",
          "Wire the dashboard to the monthly close; ~2 hours of bookkeeping per month to maintain.",
        ],
      };
    },
  },

  // R5d. CIP project resolution (medium) — fires when CIP capex is
  // material and the company has a clear cash drag from the build-out.
  {
    key: "cip_project_resolution",
    detect: (f) => {
      const cipCapex = f.pl.capitalized_own_work_memo; // 722 proxy for CIP additions
      const fcf = f.cf.cash_from_operating + f.cf.cash_used_in_investing;
      if (fcf >= 0) return null;
      if (!clearsFloor(cipCapex, f.bs.total_assets, BANDS.shareOfAssets)) return null;
      const graded = grade(
        cipCapex,
        "Capitalised build-out",
        f.bs.total_assets,
        "Total assets",
        BANDS.shareOfAssets,
        "A build-out is graded against the balance sheet funding it, so " +
          "the same spend reads as a bet-the-company project on one book " +
          "and routine maintenance capex on another.",
      );
      return {
        ruleKey: "cip_project_resolution",
        graded,
        title: `Resolve CIP project — define completion timeline and expected rental uplift`,
        factsCited: {
          cip_additions: cipCapex,
          cfo: f.cf.cash_from_operating,
          capex: f.cf.cash_used_in_investing,
          fcf,
          cash_balance: f.bs.cash,
        },
        rationaleFallback:
          `Account 231 (Construction in progress) grew by ${RON(cipCapex)} this period — the largest single cash drain ` +
          `of the year. The work is not yet generating return; FCF before financing was ${RON(fcf)} specifically because of this build-out. ` +
          `Until completion, every month of delay extends the cash-runway pressure. ` +
          ladderSentence(graded.materiality),
        actionsFallback: [
          "Define a hard completion timeline with monthly milestones; assign accountability per milestone.",
          "Model the expected rental uplift (if the work expands lettable area or upgrades the asset) and the payback period.",
          "If the project does not generate clear post-completion rental income, defer remaining non-essential capex until cash position recovers.",
          "Communicate the timeline to the lender — they price the post-CIP cash flow profile, not the current shadow.",
        ],
      };
    },
  },

  // R5e. Dividend payment timing (low) — fires when 457 has material
  // balance, signalling declared-but-unpaid distribution awaiting cash.
  {
    key: "dividends_payment_timing",
    detect: (f) => {
      const divPayable = f.bs.dividends_payable;
      if (divPayable <= 0) return null;
      if (!clearsFloor(divPayable, f.bs.cash, BANDS.shareOfCash)) return null;
      const graded = grade(
        divPayable,
        "Declared but unpaid distribution",
        f.bs.cash,
        "Cash on hand",
        BANDS.shareOfCash,
        "The question a declared-but-unpaid distribution raises is whether " +
          "the company can settle it, so it is graded against the cash " +
          "that would have to settle it rather than an absolute RON floor.",
      );
      return {
        ruleKey: "dividends_payment_timing",
        graded,
        title: `Resolve ${RON(divPayable)} dividend payment timing`,
        factsCited: {
          dividends_payable: divPayable,
          cash_balance: f.bs.cash,
          dscr_current: f.ratios.dscr,
        },
        rationaleFallback:
          `Account 457 (Dividends payable) holds ${RON(divPayable)} declared but unpaid. Either AGM authorization is pending, ` +
          `or distribution is being deferred to preserve liquidity. Either way, the obligation exists and the cash will eventually ` +
          `need to be available. ` +
          ladderSentence(graded.materiality),
        actionsFallback: [
          "Confirm intent with the shareholders — pay this year, defer to the next AGM, or convert to a different form of distribution.",
          "If deferred, document the timing decision so it doesn't drift into the next fiscal year unintentionally.",
          "Sequencing: do not pay dividends if covenant ratios are tight or if a planned intercompany recall hasn't closed.",
          "Confirm tax compliance — declared-but-unpaid dividends can still trigger Romanian withholding tax depending on the structure.",
        ],
      };
    },
  },

  // R5. Capitalized own-work disclosure (info)
  // Earnings-quality observation when 722 is material vs rental revenue.
  {
    key: "capitalized_own_work_disclosure",
    detect: (f) => {
      const cow = f.pl.capitalized_own_work_memo;
      const pctRev = cow / Math.max(f.pl.rental_revenue, 1);
      if (cow <= 0) return null;
      if (!clearsFloor(cow, f.pl.revenue, BANDS.shareOfRevenue)) return null;
      const graded = grade(
        cow,
        "Capitalised own work (722)",
        f.pl.revenue,
        "Revenue",
        BANDS.shareOfRevenue,
        "The presentation gap is graded against the top line the two " +
          "EBITDA views are both stated on, so the verdict is how much of " +
          "this company's reported margin the choice moves.",
      );
      return {
        ruleKey: "capitalized_own_work_disclosure",
        graded,
        title: `Capitalized own-work ${RON(cow)} (account 722) = ${(pctRev * 100).toFixed(0)}% of rental revenue — disclose dual view`,
        factsCited: {
          capitalized_own_work: cow,
          pct_of_rental_revenue: pctRev,
          ebitda_statutory: f.pl.ebitda,
          ebitda_operational: f.pl.ebitda_excl_capitalized,
        },
        rationaleFallback:
          `The company capitalizes labor and overhead into CIP (account 231) via 722. The offsetting cost ` +
          `sits in 628 (Other third-party services) — net P&L effect is approximately zero. However, ` +
          `statutory EBITDA ${RON(f.pl.ebitda)} (with 722) versus operational view ` +
          `${RON(f.pl.ebitda_excl_capitalized)} (without) produces a material presentation gap. ` +
          `Bank covenants typically use the statutory view; investors and analysts may compute the operational view. ` +
          ladderSentence(graded.materiality),
        actionsFallback: [
          "Maintain clear documentation showing the 722/628 wash so an auditor or lender can reconcile both views.",
          `When speaking to the lender, cite statutory EBITDA (${RON(f.pl.ebitda)}).`,
          "When speaking to a potential equity investor, present both views with the explanation.",
          "Once CIP delivers (account 231 → 215), the 722 entry stops and the two views converge — frame the convergence as a milestone.",
        ],
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════
  // TRUE DISTRESS RULES — only fire when the condition is GENUINELY
  // present on statutory inputs. The previous platform misapplied
  // Altman Z' (manufacturing) to CRE and read operational EBITDA, so
  // these rules fired falsely for EEI and produced damaging
  // recommendations (waive covenant, engage restructuring advisor,
  // exit SKUs/customers). They now stay silent unless the underlying
  // statutory condition is real.
  // ══════════════════════════════════════════════════════════════════

  // R6. True debt-service distress — fires when statutory DSCR < 1.0
  {
    key: "true_debt_service_distress",
    detect: (f) => {
      const dscr = f.ratios.dscr;
      // A CRITICAL distress card must never fire off an unmeasured DSCR.
      if (!has(dscr)) return null;
      if (dscr <= 0 || dscr >= 1.0) return null;
      return {
        ruleKey: "true_debt_service_distress",
        graded: absolute("critical", dscr, "DSCR", ABSOLUTE_WHY),
        title: `DSCR ${fx(dscr, 2)}× below 1.0 — operating income does not cover debt service`,
        factsCited: {
          dscr,
          ebitda_statutory: f.pl.ebitda,
          interest_expense: f.pl.interest_expense,
        },
        rationaleFallback:
          `Statutory EBITDA ${RON(f.pl.ebitda)} against interest + principal exceeds the covenant floor. ` +
          `Genuine covenant pressure — engage the lender proactively before the next compliance certificate. ` +
          ABSOLUTE_WHY,
        actionsFallback: [
          "Open the conversation with the lender now — surfacing the issue before they detect it preserves goodwill.",
          "Build a 13-week cash forecast under three scenarios (base / -10% revenue / -20% revenue).",
          "Identify non-core assets that can be liquidated to de-lever inside 90 days.",
          "Prepare a covenant amendment proposal that includes a step-down schedule with measurable milestones.",
        ],
      };
    },
  },

  // R7. True Altman distress — fires only on industry-appropriate variant
  // in distress zone. (The FE financialValuation.ts now uses Z" for CRE
  // and exposes the score; this rule reads that result via the ratios
  // facade rather than re-computing Altman locally.)
  {
    key: "true_distress_altman",
    detect: (f) => {
      // The score isn't currently surfaced on PeriodFacts.ratios; the
      // FE computes Altman in financialValuation.ts on the Risks tab.
      // Until period_facts.credit_facts lands, infer distress from the
      // composite of: NI < 0 AND total_equity < 0 (the actual bankruptcy
      // signature). The "true_distress_altman" rule then fires only on
      // genuine sign-correct distress, not on misapplied variants.
      const niLoss = f.pl.net_profit < 0;
      // `null < 0` is false, so an ABSENT equity total silently disabled
      // the whole Art. 153^24 distress rule — the one that tells a
      // Romanian administrator they are legally obliged to convene the
      // shareholders. Stating the guard makes that a decision instead of
      // an accident: no equity figure, no distress claim either way.
      const equity = f.bs.total_equity;
      if (equity === null) return null;
      const negativeEquity = equity < 0;
      if (!niLoss || !negativeEquity) return null;
      return {
        ruleKey: "true_distress_altman",
        graded: absolute("critical", equity, "Total equity", ABSOLUTE_WHY),
        title: `Negative equity ${RON(equity)} with operating loss — Romanian Company Law action required`,
        factsCited: {
          net_profit: f.pl.net_profit,
          total_equity: equity,
          cash: f.bs.cash,
        },
        rationaleFallback:
          `Negative book equity combined with an operating loss triggers Art. 153^24 of Romanian Company Law: ` +
          `the administrator must convene the general meeting to decide on recapitalization or dissolution. ` +
          ABSOLUTE_WHY,
        actionsFallback: [
          "Engage a restructuring advisor — this is genuine distress.",
          "Build a 13-week cash forecast and a 12-month recapitalization plan.",
          "Open a confidential conversation with the bank ahead of the next compliance test.",
          "Identify which assets can be sold inside 90 days to fund the equity cure.",
        ],
      };
    },
  },

  // R8. True negative-EBITDA — fires only when STATUTORY EBITDA < 0
  {
    key: "true_negative_ebitda",
    detect: (f) => {
      if (f.pl.ebitda >= 0) return null;
      return {
        ruleKey: "true_negative_ebitda",
        graded: absolute("critical", f.pl.ebitda, "Statutory EBITDA", ABSOLUTE_WHY),
        title: `Statutory EBITDA ${RON(f.pl.ebitda)} negative — operating model is not generating cash`,
        factsCited: {
          ebitda_statutory: f.pl.ebitda,
          rental_revenue: f.pl.rental_revenue,
        },
        rationaleFallback:
          `Statutory EBITDA is negative. Earnings-based valuation methods (EV/EBITDA, EV/Revenue) ` +
          `produce meaningless values; the company is consuming cash from operations. ` +
          ABSOLUTE_WHY,
        actionsFallback: [
          "Build a path-to-positive-EBITDA plan with month-by-month milestones over the next 12 months.",
          "Identify discretionary cost lines that can be cut without impairing the revenue base.",
          "Prepare a bridge-financing conversation with the lender now, ahead of the cash runway tightening.",
        ],
      };
    },
  },
];

// ─── Public API ─────────────────────────────────────────────────────────

export function detectConditions(facts: PeriodFacts): DetectedCondition[] {
  const industry = (facts.industry ?? "").toLowerCase();
  const candidates: RuleFinding[] = [];
  for (const rule of RULES) {
    // ── SECTOR-CALIBRATED CONTENT IS BLOCKED WHEN THE SECTOR IS IN
    //    DOUBT, NOT APPLIED BY DEFAULT ────────────────────────────────
    //
    // This read `rule.industries && industry && !includes(industry)`.
    // The middle clause meant that a period with NO classified industry
    // skipped the filter entirely, so every self-scoped rule fired on
    // every book. Measured 2026-09-07 on the four firm fixtures, all of
    // which carry `industry: null`: the agras book — a meat processor —
    // printed three commercial-real-estate lender recommendations,
    // including "Investment property carries RON 11,055,450 at book"
    // (that figure is the factory's PP&E) and "no MAC clauses tied to
    // single-tenant risk". A rule that declares a sector is calibrated
    // for that sector; an unknown sector is not a licence to apply it.
    //
    // The filter now blocks. A rule with no `industries` is unscoped and
    // still fires everywhere, which is what "generic-business rule"
    // means in the header above.
    if (rule.industries && !rule.industries.includes(industry)) continue;
    try {
      const c = rule.detect(facts);
      if (c) candidates.push(c);
    } catch (err) {
      console.error(`[recommendationRules] Rule ${rule.key} crashed:`, err);
    }
  }
  // Structural dedup by ruleKey (defensive — the rule registry doesn't
  // have duplicates by construction, but a future authoring mistake
  // would surface here instead of as a UI repetition).
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    if (seen.has(c.ruleKey)) return false;
    seen.add(c.ruleKey);
    return true;
  });
  return rankConditions(unique);
}

/** Sort key, mirroring `engine/insights/rank.py::sort_key`:
 *  level, then materiality descending, then rule key ascending.
 *
 *  `materiality: null` sorts LAST inside its level — a finding whose
 *  scale could not be established is not a bigger finding than one whose
 *  scale could. The tie-break is the KEY and not insertion order or a
 *  hash, so the same book always produces the same order and a reader
 *  comparing two runs of one report sees one sequence. */
function conditionSortKey(c: RuleFinding): [number, number, number, string] {
  const found = SEVERITY_ORDER.indexOf(c.graded.level);
  const level = found < 0 ? SEVERITY_ORDER.length : found;
  const m = c.graded.materiality;
  // ONE DELIBERATE DEVIATION FROM `rank.py`, and the measurement behind
  // it. That ranker has two tiers inside a level — a stated materiality,
  // then `null` last — because there, `null` only ever means "the scale
  // could not be established". Here a third case exists: the `true_*`
  // solvency rules are EXEMPT from scaling on purpose (`ABSOLUTE_WHY`),
  // and they also carry no materiality. Under the two-tier key they
  // sorted with the unmeasurable ones, and on the committed
  // `realestate` book that put `covenant_monitoring_dashboard` ABOVE
  // `true_negative_ebitda` inside the critical band — a dashboard errand
  // over a company consuming cash from operations. A threshold crossing
  // is not an absence of measurement; it leads its level.
  if (m.absoluteWhy) return [level, 0, 0, c.ruleKey];
  if (m.materiality === null) return [level, 2, 0, c.ruleKey];
  return [level, 1, -m.materiality, c.ruleKey];
}

/** Grade, order and stamp. Exported so a caller that assembles findings
 *  from more than one source can put them in ONE order rather than
 *  concatenating two lists that each claim to be ranked. */
export function rankConditions(findings: RuleFinding[]): DetectedCondition[] {
  const ordered = [...findings].sort((a, b) => {
    const ka = conditionSortKey(a);
    const kb = conditionSortKey(b);
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
  return ordered.map((c, index) => {
    const { graded, ...rest } = c;
    return {
      ...rest,
      level: graded.level,
      severity: COARSE_FROM_LEVEL[graded.level] ?? "info",
      materiality: graded.materiality,
      rank: index + 1,
      rankBasis: RANKING_STATEMENT,
    };
  });
}

/** Severity rank for sorting — critical first.
 *
 *  ⚠ THIS IS THE COARSE RANK, AND IT IS NO LONGER THE ORDER.
 *  `detectConditions` already returns findings in full rank order
 *  (level → materiality → key). Both call sites re-sort with this
 *  comparator; `Array.prototype.sort` is stable, and
 *  `COARSE_FROM_LEVEL` is monotonic in the fine level, so that re-sort
 *  cannot move anything — a `high` can never fall below a `medium`, and
 *  two findings sharing a coarse rung keep the materiality order they
 *  arrived in. `oneRankOneOrder.test.ts` asserts exactly that over the
 *  RENDERED export, which is the surface a re-sort would break. Prefer
 *  reading `condition.rank` over sorting again. */
export function severityRank(s: Severity): number {
  return { critical: 0, attention: 1, info: 2 }[s];
}
