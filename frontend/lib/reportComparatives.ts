// reportComparatives.ts — WHAT MOVED, AGAINST WHAT, AND WHEN THE
// QUESTION CANNOT HONESTLY BE ANSWERED.
//
// Until this file the report had no comparatives of any kind. Not a
// value, not a gap, not a sentence — the concept did not exist, so a
// document opening with "Revenue RON 118.58M" left the only question a
// reader actually has ("up from what?") unasked. `Statements` has
// carried `prior` and `historicalPeriods` since the public-company
// adapter landed; nothing on the report path ever read them.
//
// THREE THINGS THIS MODULE REFUSES TO DO, each of which is how a
// comparatives section lies.
//
// 1. It never prints 0 for a period that does not exist. A book with no
//    prior is a POSITION report and says so in those words. "0.0%" and
//    "—" both read as "no change", which is a claim about a period
//    nobody has.
//
// 2. It never labels one comparison twice. On an annual book the
//    immediately-preceding period IS last year; printing it under both
//    "vs prior period" and "vs LY" puts one number under two names —
//    the R1 defect wearing a column heading. `sameAsPriorPeriod` says
//    so and the renderer prints one column.
//
// 3. IT NEVER SUBTRACTS TWO NUMBERS THAT WERE NOT BUILT THE SAME WAY.
//    This is the one that was measured, and it is the reason the module
//    is shaped around a comparability decision rather than a
//    subtraction. `PriorPeriod` carries `balanceSheet` and
//    `incomeStatement` and NOTHING ELSE — no `absentInputs`, no
//    `reportedTotals`, no `assembled_*`. On the repo's own two-period
//    AAPL envelope the current side declares sixteen absent inputs and
//    the adapter plugs `otherNonCurrentAssets` with 294,341M so the
//    reconstructed total assets reproduces the filed 364,980M. The
//    prior side gets no such plug: its `otherNonCurrentAssets` is 0, so
//    `deriveTotals` reads its total assets as 65,804M against a filed
//    352,583M. A first draft of this file subtracted those and reported
//    total assets UP 299,176M — +454% — on a company whose assets grew
//    12,397M. The variance was a methodology difference wearing a
//    percentage.
//
//    So: a line is comparable only when NEITHER side reached its figure
//    through something the other side cannot have. Concretely, a line
//    refuses when any input it consumes is in the current period's
//    `absentInputs`, or when the current period's figure comes off
//    `reportedTotals` (which a `PriorPeriod` has no way to carry). The
//    refusal names the input. On a Romanian trial balance neither
//    condition holds — the line items ARE the source — so the private
//    path gets every line the moment a prior period reaches it.

import {
  deriveTotals,
  type PriorPeriod,
  type ReportedTotalKey,
  type StatementInput,
  type Statements,
} from "./financialReport";

export type VarianceDirection = "up" | "down" | "flat";

/** One period-over-period move, or a stated reason there is none. */
export interface Variance {
  /** current − comparison, in the line's own unit. */
  absolute: number | null;
  /** (current − comparison) ÷ |comparison| × 100. NULL when the
   *  comparison is zero — a percentage change from nothing is not
   *  infinity and is not 100%; it is undefined, and `absolute` still
   *  carries the whole move. */
  percent: number | null;
  direction: VarianceDirection | null;
  /** Present iff `absolute` is null. The reason, in the product's words. */
  unavailable: string | null;
}

export type ComparisonKind = "prior_period" | "prior_year";

export interface ComparisonPeriod {
  kind: ComparisonKind;
  /** The column heading. */
  heading: string;
  /** The comparison period's own label, as its source states it. */
  periodLabel: string;
  /** True when this comparison and the prior period are ONE period — an
   *  annual book, where "previous" and "last year" name the same filing.
   *  The renderer must then print one column, not two. */
  sameAsPriorPeriod: boolean;
}

export interface ComparativeLine {
  key: string;
  label: string;
  unit: "money" | "pct" | "x";
  current: number | null;
  /** FALSE when the two sides are not built the same way. `vs` then
   *  carries the stated reason on both kinds. */
  comparable: boolean;
  vs: Record<ComparisonKind, Variance>;
}

export interface Comparatives {
  /** FALSE on every book the private RO path serves today: nothing in
   *  the engine populates `statements.prior` for a trial-balance upload. */
  available: boolean;
  /** The exact sentence the report prints when there is nothing to
   *  compare against. Not a dash, not a zero, not silence. */
  degradedNote: string;
  /** Why, specifically, on this book. Null when comparatives exist. */
  degradedReason: string | null;
  periods: ComparisonPeriod[];
  lines: ComparativeLine[];
}

export const NO_COMPARATIVES_NOTE =
  "No comparatives — position report, not performance report";

/** The per-cell form, for a grid where the sentence above is already in
 *  the column header and repeating it forty times is noise. Still three
 *  words rather than a dash or a blank: in a spreadsheet an empty delta
 *  cell and a zero delta cell read the same at a glance. */
export const NO_COMPARATIVE_CELL = "no prior period";

const NO_PRIOR = "no prior period was supplied with this book";

const degraded = (reason: string): Variance => ({
  absolute: null,
  percent: null,
  direction: null,
  unavailable: reason,
});

/** A move is "flat" only when it is EXACTLY zero. A move that rounds to
 *  zero is still a move, and calling it flat is the same lie as printing
 *  a dash for an absent one. */
function varianceOf(current: number | null, comparison: number | null): Variance {
  if (current === null || !Number.isFinite(current)) {
    return degraded("the current period does not report this line");
  }
  if (comparison === null || !Number.isFinite(comparison)) {
    return degraded("the comparison period does not report this line");
  }
  const absolute = current - comparison;
  return {
    absolute,
    percent: comparison === 0 ? null : (absolute / Math.abs(comparison)) * 100,
    direction: absolute > 0 ? "up" : absolute < 0 ? "down" : "flat",
    unavailable: null,
  };
}

interface Side {
  incomeStatement: Statements["incomeStatement"];
  totals: ReturnType<typeof deriveTotals>;
}

interface LineSpec {
  key: string;
  label: string;
  unit: ComparativeLine["unit"];
  of: (x: Side) => number | null;
  /** Every statement line this figure consumes. If ANY of them is in the
   *  current period's `absentInputs`, the two sides were not built the
   *  same way and the line refuses. */
  inputs: readonly StatementInput[];
  /** The `reportedTotals` key this figure may be served as. A
   *  `PriorPeriod` cannot carry reported totals, so a current figure
   *  taken from one has no like-for-like counterpart. */
  reportedAs?: readonly ReportedTotalKey[];
}

const safeRatio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

const REVENUE: readonly StatementInput[] = ["revenue"];
const PL_TO_EBITDA: readonly StatementInput[] = [
  "revenue",
  "costOfGoodsSold",
  "operatingExpenses",
  "otherIncome",
];
const PL_TO_NET: readonly StatementInput[] = [
  ...PL_TO_EBITDA,
  "depreciationAmortization",
  "interestExpense",
  "taxExpense",
];
const BS_ASSETS: readonly StatementInput[] = [
  "cash",
  "accountsReceivable",
  "inventory",
  "otherCurrentAssets",
  "propertyPlantEquipment",
  "intangibles",
  "otherNonCurrentAssets",
];
const BS_EQUITY: readonly StatementInput[] = ["shareCapital", "retainedEarnings", "otherEquity"];
const BS_DEBT: readonly StatementInput[] = ["shortTermDebt", "longTermDebt", "cash"];

export const COMPARATIVE_LINES: readonly LineSpec[] = [
  { key: "revenue", label: "Revenue", unit: "money", inputs: REVENUE, of: (x) => x.incomeStatement.revenue },
  {
    key: "gross_profit", label: "Gross profit", unit: "money",
    inputs: ["revenue", "costOfGoodsSold"], reportedAs: ["grossProfit"],
    of: (x) => x.totals.grossProfit,
  },
  {
    key: "ebitda", label: "EBITDA", unit: "money",
    inputs: PL_TO_EBITDA, reportedAs: ["ebitda"], of: (x) => x.totals.ebitda,
  },
  {
    key: "ebit", label: "EBIT", unit: "money",
    inputs: [...PL_TO_EBITDA, "depreciationAmortization"], reportedAs: ["ebit"],
    of: (x) => x.totals.ebit,
  },
  {
    key: "net_income", label: "Net income", unit: "money",
    inputs: PL_TO_NET, reportedAs: ["netIncome", "pbt"], of: (x) => x.totals.netIncome,
  },
  {
    key: "ebitda_margin", label: "EBITDA margin", unit: "pct",
    inputs: PL_TO_EBITDA, reportedAs: ["ebitda"],
    of: (x) => {
      const r = safeRatio(x.totals.ebitda, x.incomeStatement.revenue);
      return r === null ? null : r * 100;
    },
  },
  {
    key: "net_margin", label: "Net margin", unit: "pct",
    inputs: PL_TO_NET, reportedAs: ["netIncome"],
    of: (x) => {
      const r = safeRatio(x.totals.netIncome, x.incomeStatement.revenue);
      return r === null ? null : r * 100;
    },
  },
  {
    key: "total_assets", label: "Total assets", unit: "money",
    inputs: BS_ASSETS, reportedAs: ["totalAssets", "totalCurrentAssets", "totalNonCurrentAssets"],
    of: (x) => x.totals.totalAssets,
  },
  {
    key: "total_equity", label: "Total equity", unit: "money",
    inputs: BS_EQUITY, reportedAs: ["totalEquity"], of: (x) => x.totals.totalEquity,
  },
  {
    key: "equity_ratio", label: "Equity ratio", unit: "pct",
    inputs: [...BS_EQUITY, ...BS_ASSETS], reportedAs: ["totalEquity", "totalAssets"],
    of: (x) => {
      const r = safeRatio(x.totals.totalEquity, x.totals.totalAssets);
      return r === null ? null : r * 100;
    },
  },
  {
    key: "net_debt", label: "Net debt", unit: "money",
    inputs: BS_DEBT, reportedAs: ["totalDebt"], of: (x) => x.totals.netDebt,
  },
  {
    key: "net_debt_ebitda", label: "Net debt / EBITDA", unit: "x",
    inputs: [...BS_DEBT, ...PL_TO_EBITDA], reportedAs: ["totalDebt", "ebitda"],
    of: (x) => safeRatio(x.totals.netDebt, x.totals.ebitda),
  },
] as const;

/** Why this line cannot be compared, or null when it can. */
function incomparableBecause(s: Statements, spec: LineSpec): string | null {
  const absent = new Set<StatementInput>(s.absentInputs ?? []);
  const hit = spec.inputs.filter((i) => absent.has(i));
  if (hit.length > 0) {
    return (
      `this source did not report ${hit.join(", ")} for the current period, so its ` +
      `figure comes from a total rather than the line items — and a prior period ` +
      `carries no such total to compare it against`
    );
  }
  const reported = s.reportedTotals ?? {};
  const served = (spec.reportedAs ?? []).filter((k) => typeof reported[k] === "number");
  if (served.length > 0) {
    return (
      `the current period's ${served.join(" / ")} is a total the source reported directly, ` +
      `and a prior period carries no reported totals — subtracting the two would compare ` +
      `a filed figure against a reconstructed one`
    );
  }
  return null;
}

/** `deriveTotals` wants a whole `Statements`; a `PriorPeriod` carries
 *  only the two statements. The shell supplies the rest and deliberately
 *  strips every CURRENT-period block, so the prior side can never quote
 *  this period's assembled or canonical figures. */
function shellFor(s: Statements, p: PriorPeriod): Statements {
  return {
    ...s,
    periodLabel: p.periodLabel,
    balanceSheet: p.balanceSheet,
    incomeStatement: p.incomeStatement,
    prior: undefined,
    historicalPeriods: undefined,
    assembled_pl: undefined,
    assembled_bs: undefined,
    assembled_cf: undefined,
    canonical_bs: undefined,
    reportedTotals: undefined,
  };
}

/** True when the current period covers a year, so its immediate
 *  predecessor IS last year. `periodDays` is the source's own statement
 *  of span; absent, an annual book is assumed — every private RO upload
 *  this product accepts is a full-year trial balance — and the
 *  assumption is stated in the column heading rather than hidden. */
function isAnnual(s: Statements): boolean {
  const d = s.supplementary.periodDays;
  return d === undefined || d === null || d >= 350;
}

/**
 * @param currentOverrides figures the CALLER already resolved and prints
 *   elsewhere in the same document, keyed by line key. Supplied so the
 *   tiles quote the document's own EBITDA / net income (the renderer's
 *   `pick(assembled_pl.*, deriveTotals.*)`) rather than becoming a third
 *   spelling of them, which is R1 in a KPI strip.
 */
export function buildComparatives(
  s: Statements,
  currentOverrides: Readonly<Record<string, number | null>> = {},
): Comparatives {
  const currentSide: Side = { incomeStatement: s.incomeStatement, totals: deriveTotals(s) };
  const currentOf = (spec: LineSpec): number | null =>
    Object.prototype.hasOwnProperty.call(currentOverrides, spec.key)
      ? currentOverrides[spec.key]
      : spec.of(currentSide);

  const priors: PriorPeriod[] = [];
  if (s.prior) priors.push(s.prior);
  const history = s.historicalPeriods ?? [];

  if (priors.length === 0 && history.length === 0) {
    return {
      available: false,
      degradedNote: NO_COMPARATIVES_NOTE,
      degradedReason: NO_PRIOR,
      periods: [],
      lines: COMPARATIVE_LINES.map((spec) => ({
        key: spec.key,
        label: spec.label,
        unit: spec.unit,
        current: currentOf(spec),
        comparable: false,
        vs: { prior_period: degraded(NO_PRIOR), prior_year: degraded(NO_PRIOR) },
      })),
    };
  }

  const annual = isAnnual(s);
  const priorPeriod: PriorPeriod | null = priors[0] ?? history[history.length - 1] ?? null;
  // On an annual book the prior period IS last year. On a shorter one it
  // is four quarters back, which the source only lets us find by
  // counting `historicalPeriods` — and when there are not enough, the
  // answer is a stated gap, never the nearest period standing in for it.
  const priorYear: PriorPeriod | null = annual ? priorPeriod : (history[history.length - 4] ?? null);

  const periods: ComparisonPeriod[] = [];
  if (priorPeriod) {
    periods.push({
      kind: "prior_period",
      heading: "vs prior period",
      periodLabel: priorPeriod.periodLabel,
      sameAsPriorPeriod: false,
    });
  }
  if (priorYear) {
    periods.push({
      kind: "prior_year",
      heading: annual
        ? "vs last year (the same period — this book covers a full year)"
        : "vs last year",
      periodLabel: priorYear.periodLabel,
      sameAsPriorPeriod: priorYear === priorPeriod,
    });
  }

  const sideFor = (p: PriorPeriod | null): Side | null =>
    p === null ? null : { incomeStatement: p.incomeStatement, totals: deriveTotals(shellFor(s, p)) };
  const priorSide = sideFor(priorPeriod);
  const yearSide = sideFor(priorYear);

  return {
    available: true,
    degradedNote: NO_COMPARATIVES_NOTE,
    degradedReason: null,
    periods,
    lines: COMPARATIVE_LINES.map((spec) => {
      const blocked = incomparableBecause(s, spec);
      const against = (side: Side | null, noPeriod: string): Variance => {
        if (blocked !== null) return degraded(blocked);
        if (side === null) return degraded(noPeriod);
        return varianceOf(currentOf(spec), spec.of(side));
      };
      return {
        key: spec.key,
        label: spec.label,
        unit: spec.unit,
        current: currentOf(spec),
        comparable: blocked === null,
        vs: {
          prior_period: against(priorSide, "no immediately-preceding period was supplied"),
          prior_year: against(
            yearSide,
            "no period one year back was supplied — this book carries " +
              `${history.length} historical period(s), and a year needs four quarters`,
          ),
        },
      };
    }),
  };
}

export function comparativeLine(c: Comparatives, key: string): ComparativeLine | null {
  return c.lines.find((l) => l.key === key) ?? null;
}

/** The printable form of one variance. The ONE formatter, so no surface
 *  invents "0.0%" for a move nobody measured. */
export function formatVariance(v: Variance, unit: ComparativeLine["unit"]): string {
  if (v.absolute === null) return NO_COMPARATIVES_NOTE;
  const arrow = v.direction === "up" ? "+" : v.direction === "down" ? "−" : "±";
  const abs = Math.abs(v.absolute);
  const magnitude =
    unit === "pct"
      ? `${abs.toFixed(1)} pp`
      : unit === "x"
        ? `${abs.toFixed(2)}×`
        : abs.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const share =
    v.percent === null
      ? " (no percentage — the comparison period is zero on this line)"
      : ` (${arrow}${Math.abs(v.percent).toFixed(1)}%)`;
  return `${arrow}${magnitude}${share}`;
}
